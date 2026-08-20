import { PostgresService } from "../../src/postgres/postgres.service";
import { Fixtures } from "./fixtures";
import { runAsUser } from "./sql-test-db";

// Tournament-flow builders shared by the tournament specs. All state changes
// run under the organizer's admin session, matching how Hasura delivers them.

export type StageSpec = {
  type: string;
  order: number;
  minTeams: number;
  maxTeams: number;
  thirdPlaceMatch?: boolean;
};

export type BracketRow = {
  id: string;
  round: number;
  match_number: number;
  group: number;
  match_id: string | null;
  tournament_team_id_1: string | null;
  tournament_team_id_2: string | null;
  finished: boolean;
};

export class TournamentFixtures {
  constructor(
    private readonly postgres: PostgresService,
    private readonly fx: Fixtures,
  ) {}

  async createTournament(
    stages: Array<StageSpec>,
    matchType = "Wingman",
  ): Promise<{
    id: string;
    organizer: string;
    stageIds: Array<string>;
  }> {
    const organizer = await this.fx.player();
    const [options] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, $1, id, false, true, '{TestA}'
       FROM map_pools WHERE type = $1 AND seed = true RETURNING id`,
      [matchType],
    );
    // The rest of this fixture (and most of the existing suite) predates
    // awards_enabled defaulting to false for new tournaments -- keep the
    // fixture's own default at true so unrelated tests keep exercising the
    // calculated-awards path they already assume. Tests for the
    // awards-disabled behavior itself set it back to false explicitly.
    // Both columns must be set together: nothing syncs them at INSERT time
    // (the sync trigger only fires on UPDATE), so leaving trophies_enabled
    // on its column default here would desync it from awards_enabled=true.
    //
    // Same reasoning for min_role: it defaults to 'verified_user' for new
    // tournaments, and roster-insert enforcement of that default now
    // genuinely runs (tbi_tournament_team_roster / target_meets_min_role),
    // where before it only gated the acting session, never the target
    // player. registerTeam()/launch() below enroll default-role ('user')
    // fixture players, so leaving the column default here would newly block
    // every unrelated suite's fixture rosters. Explicitly unrestricted;
    // the tournament-min-role*.spec.ts suites set their own min_role
    // per-test via direct UPDATEs, so this doesn't affect them.
    const [tournament] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
          (name, start, organizer_steam_id, match_options_id, status, awards_enabled, trophies_enabled, min_role)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', true, true, NULL) RETURNING id`,
      [this.fx.nextName("cup"), organizer, options.id],
    );
    const stageIds: Array<string> = [];
    for (const stage of stages) {
      const [row] = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages
            (tournament_id, type, "order", min_teams, max_teams, third_place_match)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          tournament.id,
          stage.type,
          stage.order,
          stage.minTeams,
          stage.maxTeams,
          stage.thirdPlaceMatch ?? false,
        ],
      );
      stageIds.push(row.id);
    }
    return { id: tournament.id, organizer, stageIds };
  }

  setStatus(
    tournamentId: string,
    organizer: string,
    status: string,
  ): Promise<unknown> {
    return runAsUser(this.postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );
  }

  registerTeam(
    tournamentId: string,
    team: { id: string; owner: string },
  ): Promise<string> {
    return runAsUser(this.postgres, team.owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
        [tournamentId, team.id],
      )) as Array<{ id: string }>;
      return row.id;
    });
  }

  // Registers `teamCount` correctly sized teams and walks the tournament to
  // Live, at which point stage 1 is seeded and scheduled.
  async launch(
    stages: Array<StageSpec>,
    teamCount: number,
    matchType = "Wingman",
  ): Promise<{ id: string; organizer: string; stageIds: Array<string> }> {
    const tournament = await this.createTournament(stages, matchType);
    const teammateCount =
      matchType === "Duel" ? 0 : matchType === "Wingman" ? 1 : 4;
    await this.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < teamCount; i++) {
      await this.registerTeam(
        tournament.id,
        await this.fx.team(teammateCount),
      );
    }
    await this.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    await this.setStatus(tournament.id, tournament.organizer, "Live");
    return tournament;
  }

  getBrackets(stageId: string): Promise<Array<BracketRow>> {
    return this.postgres.query<Array<BracketRow>>(
      `SELECT id, round, match_number, "group", match_id,
              tournament_team_id_1, tournament_team_id_2, finished
       FROM tournament_brackets
       WHERE tournament_stage_id = $1
       ORDER BY round, "group", match_number`,
      [stageId],
    );
  }

  winMatch(
    matchId: string,
    lineup: "lineup_1_id" | "lineup_2_id" = "lineup_1_id",
  ): Promise<unknown> {
    return this.postgres.query(
      `UPDATE matches SET winning_lineup_id = ${lineup} WHERE id = $1`,
      [matchId],
    );
  }

  // Wins every unfinished scheduled match of a round, lineup 1 taking it,
  // one at a time so per-match side effects (pool assignment, scheduling the
  // next round) run exactly as they would in production.
  async playRound(stageId: string, round: number): Promise<number> {
    const brackets = await this.postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM tournament_brackets
       WHERE tournament_stage_id = $1 AND round = $2
         AND match_id IS NOT NULL AND finished = false
       ORDER BY match_number`,
      [stageId, round],
    );
    for (const bracket of brackets) {
      await this.winMatch(bracket.match_id);
    }
    return brackets.length;
  }

  async tournamentStatus(id: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [id],
    );
    return row.status;
  }

  stageResults(
    stageId: string,
  ): Promise<Array<{ tournament_team_id: string; wins: number; losses: number }>> {
    return this.postgres.query<
      Array<{ tournament_team_id: string; wins: number; losses: number }>
    >(
      `SELECT tournament_team_id, wins, losses FROM v_team_stage_results
       WHERE tournament_stage_id = $1 ORDER BY wins DESC, losses ASC`,
      [stageId],
    );
  }
}
