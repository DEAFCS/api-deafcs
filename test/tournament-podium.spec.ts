import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The podium is the tournament's result, so it shows whether or not awards are
// handed out. It reads tournament_placements (5stackgg/api 30ca37b): the final
// and the third-place decider order a single elimination final directly, and
// without a decider both semifinal losers share 3rd instead of the standings'
// tiebreakers picking one of them.
//
// DEAFCS: tournament_podium returns the placements only (no players), and the
// placement awards still come from calculate_tournament_awards, unchanged.
describe("tournament podium (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPodiumTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199695000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  type Step = {
    placement: number;
    tournament_team_id: string;
    team_id: string | null;
    name: string;
  };

  const podium = async (tournamentId: string): Promise<Array<Step> | null> => {
    const [row] = await postgres.query<Array<{ podium: Array<Step> | null }>>(
      "SELECT tournament_podium(t) AS podium FROM tournaments t WHERE t.id = $1",
      [tournamentId],
    );
    return row.podium;
  };

  // Lineup 1 wins every match that exists, round by round, until the stage
  // has nothing left to play.
  const playStage = async (stageId: string): Promise<void> => {
    for (let pass = 0; pass < 20; pass++) {
      const pending = await postgres.query<Array<{ match_id: string }>>(
        `SELECT tb.match_id
           FROM tournament_brackets tb
           JOIN matches m ON m.id = tb.match_id
          WHERE tb.tournament_stage_id = $1
            AND tb.finished = false
            AND m.winning_lineup_id IS NULL
          ORDER BY tb.round, tb.match_number`,
        [stageId],
      );
      if (pending.length === 0) {
        return;
      }
      for (const { match_id } of pending) {
        await tfx.winMatch(match_id);
      }
    }
  };

  const cup = async ({
    thirdPlaceMatch,
    awards = true,
  }: {
    thirdPlaceMatch: boolean;
    awards?: boolean;
  }) => {
    const t = await tfx.launch(
      [
        {
          type: "SingleElimination",
          order: 1,
          minTeams: 4,
          maxTeams: 4,
          thirdPlaceMatch,
        },
      ],
      4,
    );
    await postgres.query(
      "UPDATE tournaments SET awards_enabled = $2, trophies_enabled = $2 WHERE id = $1",
      [t.id, awards],
    );
    return t;
  };

  const finalRound = (stageId: string) =>
    postgres.query<
      Array<{ match_number: number; team_1: string; team_2: string }>
    >(
      `SELECT match_number, tournament_team_id_1 AS team_1, tournament_team_id_2 AS team_2
         FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 2 AND path = 'WB'
        ORDER BY match_number`,
      [stageId],
    );

  it("orders 1st, 2nd and 3rd from the final and the third-place decider", async () => {
    const t = await cup({ thirdPlaceMatch: true });
    expect(await podium(t.id)).toBeNull();

    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const [final, decider] = await finalRound(t.stageIds[0]);
    const steps = (await podium(t.id))!;

    expect(
      steps.map((step) => [step.placement, step.tournament_team_id]),
    ).toEqual([
      [1, final.team_1],
      [2, final.team_2],
      [3, decider.team_1],
    ]);
    for (const step of steps) {
      expect(step.name).toBeTruthy();
    }
  });

  it("puts both semifinal losers at 3rd when there is no third-place match", async () => {
    const t = await cup({ thirdPlaceMatch: false });
    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const semifinals = await postgres.query<
      Array<{ team_1: string; team_2: string }>
    >(
      `SELECT tournament_team_id_1 AS team_1, tournament_team_id_2 AS team_2
         FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 1 AND path = 'WB'`,
      [t.stageIds[0]],
    );
    const steps = (await podium(t.id))!;

    expect(steps.map((step) => step.placement)).toEqual([1, 2, 3, 3]);
    expect(
      steps
        .filter((step) => step.placement === 3)
        .map((step) => step.tournament_team_id)
        .sort(),
    ).toEqual(semifinals.map((semi) => semi.team_2).sort());
  });

  it("still shows the podium when awards are off", async () => {
    const t = await cup({ thirdPlaceMatch: true, awards: false });
    await playStage(t.stageIds[0]);

    expect((await podium(t.id))!.map((step) => step.placement)).toEqual([
      1, 2, 3,
    ]);
  });

  it("takes a round robin's podium from its standings", async () => {
    const t = await tfx.launch(
      [{ type: "RoundRobin", order: 1, minTeams: 4, maxTeams: 4 }],
      4,
    );
    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const standings = await postgres.query<
      Array<{ placement: number; tournament_team_id: string }>
    >(
      `SELECT placement, tournament_team_id FROM v_team_stage_results
        WHERE tournament_stage_id = $1 AND placement IN (1, 2, 3)
        ORDER BY placement, tournament_team_id::text`,
      [t.stageIds[0]],
    );
    const steps = (await podium(t.id))!;

    expect(
      steps
        .map(({ placement, tournament_team_id }) => ({
          placement,
          tournament_team_id,
        }))
        .sort(
          (a, b) =>
            a.placement - b.placement ||
            a.tournament_team_id.localeCompare(b.tournament_team_id),
        ),
    ).toEqual(standings);
  });
});
