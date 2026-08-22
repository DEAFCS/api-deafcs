import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// get_tournament_leaderboard is assembled from two already-proven
// aggregations (see the function's own header comment):
//   - kills/deaths/assists/headshots/matches_played: the same kill-event
//     aggregation v_tournament_player_stats already uses.
//   - rating/adr: the same rounds-weighted aggregation get_event_leaderboard
//     already uses (SUM(value * rounds_played) / SUM(rounds_played)).
// This spec proves the tournament-scoped assembly itself: strict scoping to
// one tournament, correct per-field math, and both team-identity paths
// (normal team, Solo Random / ad-hoc generated team).
type LeaderboardRow = {
  player_steam_id: string;
  player_name: string;
  player_avatar_url: string | null;
  player_custom_avatar_url: string | null;
  player_country: string | null;
  tournament_team_id: string | null;
  team_id: string | null;
  team_name: string | null;
  rating: string;
  adr: string;
  kills: number;
  deaths: number;
  assists: number;
  kdr: string;
  headshot_percentage: string;
  rounds_played: number;
  matches_played: number;
};

describe("get_tournament_leaderboard", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournamentFx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentLeaderboardTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199960000000n);
    tournamentFx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  async function leaderboard(tournamentId: string): Promise<LeaderboardRow[]> {
    return postgres.query<LeaderboardRow[]>(
      "SELECT * FROM get_tournament_leaderboard($1::uuid, NULL)",
      [tournamentId],
    );
  }

  function rowFor(rows: LeaderboardRow[], steamId: string): LeaderboardRow {
    const row = rows.find((r) => r.player_steam_id === steamId);
    if (!row) {
      throw new Error(`no leaderboard row for ${steamId}`);
    }
    return row;
  }

  // fx.match()'s auto-materialization of match_maps only fires when the
  // options' map pool size exactly equals best_of (see Fixtures.mapPool's
  // own doc comment); the seeded Wingman pool (6 maps) never satisfies that
  // for a best_of 1, so it defers to a veto that never resolves and
  // match_maps stays empty. fx.bareMatch() sidesteps map_options/veto
  // entirely -- a match, two lineups, and one match_map already made -- the
  // same fixture views.spec.ts's own v_player_match_map_hltv test uses for
  // exactly this reason. Lineup ids aren't part of its return value, so
  // fetch them once here.
  async function bareMatchWithLineups(): Promise<{
    matchId: string;
    mapId: string;
    lineup1Id: string;
    lineup2Id: string;
  }> {
    const { matchId, mapId } = await fx.bareMatch();
    const [row] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    return {
      matchId,
      mapId,
      lineup1Id: row.lineup_1_id,
      lineup2Id: row.lineup_2_id,
    };
  }

  // Wires an arbitrary match into a tournament's bracket directly, bypassing
  // real bracket seeding/progression -- get_tournament_leaderboard only
  // cares that a tournament_brackets row exists with a non-null match_id
  // under a stage belonging to the tournament, so this gives full control
  // over exactly which matches/maps feed a tournament's leaderboard without
  // fighting Single Elimination advancement rules.
  async function attachMatchToStage(
    stageId: string,
    matchId: string,
  ): Promise<void> {
    await postgres.query(
      `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
       VALUES ($1, $2, 1)`,
      [stageId, matchId],
    );
  }

  // Normal team: a real teams row backing the tournament_team, so team_id
  // resolves and team_name comes from the real team's own name.
  //
  // tournament_team_roster inserts are trigger-guarded
  // (tbi_tournament_team_roster reads current_setting('hasura.user') to
  // decide admin/organizer-driven vs a regular player join -- see
  // tournament-team-generation.service.ts's identical concern) and throw an
  // "unrecognized configuration parameter" error on a bare connection, so
  // both inserts run under runAsUser exactly like
  // TournamentFixtures.registerTeam() does.
  async function makeRegisteredTeam(
    tournamentId: string,
    name: string,
    players: string[],
  ): Promise<{ tournamentTeamId: string; teamId: string }> {
    const owner = players[0];
    const [team] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [name, owner],
    );
    return runAsUser(postgres, owner, "admin", async (query) => {
      const [tournamentTeam] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [tournamentId, team.id, name, owner],
      )) as Array<{ id: string }>;
      for (const steamId of players) {
        await query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [tournamentTeam.id, steamId, tournamentId],
        );
      }
      return { tournamentTeamId: tournamentTeam.id, teamId: team.id };
    });
  }

  // Solo Random / generated team shape: tournament_teams.team_id is NULL
  // (no backing real team), exactly what
  // tournament-team-generation.service.ts produces for auto-assigned teams.
  // Same runAsUser requirement as makeRegisteredTeam above.
  async function makeGeneratedTeam(
    tournamentId: string,
    name: string,
    players: string[],
  ): Promise<{ tournamentTeamId: string }> {
    const owner = players[0];
    return runAsUser(postgres, owner, "admin", async (query) => {
      const [tournamentTeam] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, NULL, $2, $3, $3) RETURNING id`,
        [tournamentId, name, owner],
      )) as Array<{ id: string }>;
      for (const steamId of players) {
        await query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [tournamentTeam.id, steamId, tournamentId],
        );
      }
      return { tournamentTeamId: tournamentTeam.id };
    });
  }

  async function makeStage(): Promise<{ id: string; organizer: string; stageIds: string[] }> {
    return tournamentFx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ]);
  }

  describe("tournament scoping", () => {
    it("does not leak matches/players from a different tournament", async () => {
      const tA = await makeStage();
      const tB = await makeStage();

      const [playerA1, playerA2] = await fx.players(2);
      const a = await bareMatchWithLineups();
      await fx.lineupPlayer(a.lineup1Id, playerA1);
      await fx.lineupPlayer(a.lineup2Id, playerA2);
      await attachMatchToStage(tA.stageIds[0], a.matchId);
      await fx.kill(a, playerA1, playerA2, { round: 1 });

      const [playerB1, playerB2] = await fx.players(2);
      const b = await bareMatchWithLineups();
      await fx.lineupPlayer(b.lineup1Id, playerB1);
      await fx.lineupPlayer(b.lineup2Id, playerB2);
      await attachMatchToStage(tB.stageIds[0], b.matchId);
      await fx.kill(b, playerB1, playerB2, { round: 1 });

      const rowsA = await leaderboard(tA.id);
      const rowsB = await leaderboard(tB.id);

      expect(rowsA.map((r) => r.player_steam_id).sort()).toEqual(
        [playerA1, playerA2].sort(),
      );
      expect(rowsB.map((r) => r.player_steam_id).sort()).toEqual(
        [playerB1, playerB2].sort(),
      );
    });
  });

  describe("per-player stat correctness (single map)", () => {
    let tournamentId: string;
    let ace: string;
    let victim: string;

    beforeEach(async () => {
      const t = await makeStage();
      tournamentId = t.id;
      [ace, victim] = await fx.players(2);
      const m = await bareMatchWithLineups();
      await fx.lineupPlayer(m.lineup1Id, ace);
      await fx.lineupPlayer(m.lineup2Id, victim);
      await attachMatchToStage(t.stageIds[0], m.matchId);

      // ace: 2 kills (1 headshot) + 140 damage across 2 rounds, dies once.
      await fx.kill(m, ace, victim, { round: 1, headshot: true });
      await fx.kill(m, ace, victim, { round: 2, headshot: false });
      await fx.kill(m, victim, ace, { round: 2 });
      await fx.assist(m, victim, ace);
      await fx.damage(m, ace, victim, 80, { round: 1 });
      await fx.damage(m, ace, victim, 60, { round: 2 });
      await fx.round(m.mapId, 1);
      await fx.round(m.mapId, 2);
    });

    it("counts kills correctly", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      expect(row.kills).toBe(2);
    });

    it("counts deaths correctly", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      expect(row.deaths).toBe(1);
    });

    it("counts assists correctly", async () => {
      const row = rowFor(await leaderboard(tournamentId), victim);
      expect(row.assists).toBe(1);
    });

    it("computes K/D as kills divided by deaths", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      // 2 kills / 1 death
      expect(Number(row.kdr)).toBeCloseTo(2, 2);
    });

    it("exposes raw kills/deaths for the frontend's K-D (kills minus deaths) derivation", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      expect(row.kills - row.deaths).toBe(1);
    });

    it("computes headshot percentage from headshot kills over total kills", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      // 1 of 2 kills was a headshot.
      expect(Number(row.headshot_percentage)).toBeCloseTo(50, 1);
    });

    it("counts matches_played from lineup membership", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      expect(row.matches_played).toBe(1);
    });

    it("counts rounds_played from player_match_map_stats", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      expect(row.rounds_played).toBe(2);
    });

    it("computes ADR as total damage divided by total rounds", async () => {
      const row = rowFor(await leaderboard(tournamentId), ace);
      // 140 damage / 2 rounds = 70
      expect(Number(row.adr)).toBeCloseTo(70, 1);
    });
  });

  describe("rating: rounds-weighted across maps, not a naive average", () => {
    it("SUM(hltv_rating * rounds_played) / SUM(rounds_played), proven against a naive average", async () => {
      const t = await makeStage();
      const [player, opponent] = await fx.players(2);

      // Map 1: a short, dominant map for `player` -- few rounds, high rating.
      const m1 = await bareMatchWithLineups();
      await fx.lineupPlayer(m1.lineup1Id, player);
      await fx.lineupPlayer(m1.lineup2Id, opponent);
      await attachMatchToStage(t.stageIds[0], m1.matchId);
      for (let round = 1; round <= 2; round++) {
        await fx.kill(m1, player, opponent, { round });
        await fx.damage(m1, player, opponent, 100, { round });
      }
      await fx.round(m1.mapId, 1);
      await fx.round(m1.mapId, 2);

      // Map 2 (separate match/map, still the same tournament/player): many
      // more rounds, weak performance -- low rating. Attached as a second
      // bracket entry in the same stage.
      const m2 = await bareMatchWithLineups();
      await fx.lineupPlayer(m2.lineup1Id, player);
      await fx.lineupPlayer(m2.lineup2Id, opponent);
      await attachMatchToStage(t.stageIds[0], m2.matchId);
      for (let round = 1; round <= 14; round++) {
        // player dies every round, no kills/damage of their own.
        await fx.kill(m2, opponent, player, { round });
        await fx.round(m2.mapId, round);
      }

      const rows = await postgres.query<
        Array<{ hltv_rating: string; rounds_played: number }>
      >(
        `SELECT hltv_rating, rounds_played FROM v_player_match_map_hltv
         WHERE steam_id = $1 AND match_map_id = ANY($2::uuid[])`,
        [player, [m1.mapId, m2.mapId]],
      );
      expect(rows).toHaveLength(2);
      const [r1, r2] = rows[0].rounds_played === 2 ? rows : [rows[1], rows[0]];
      expect(r1.rounds_played).toBe(2);
      expect(r2.rounds_played).toBe(14);
      // Map 1 (dominant, short) must genuinely outrate map 2 (weak, long) for
      // this fixture to actually test weighting instead of coincidentally
      // producing the same number either way.
      expect(Number(r1.hltv_rating)).toBeGreaterThan(Number(r2.hltv_rating));

      const naiveAverage =
        (Number(r1.hltv_rating) + Number(r2.hltv_rating)) / 2;
      const roundsWeightedAverage =
        (Number(r1.hltv_rating) * r1.rounds_played +
          Number(r2.hltv_rating) * r2.rounds_played) /
        (r1.rounds_played + r2.rounds_played);

      // The two aggregations must actually diverge, or this fixture doesn't
      // prove anything -- 14 low-rating rounds dominating 2 high-rating
      // rounds pulls the weighted figure well below the naive 50/50 average.
      expect(roundsWeightedAverage).not.toBeCloseTo(naiveAverage, 2);

      const row = rowFor(await leaderboard(t.id), player);
      expect(Number(row.rating)).toBeCloseTo(roundsWeightedAverage, 2);
      expect(Number(row.rating)).not.toBeCloseTo(naiveAverage, 2);
    });
  });

  describe("team identity resolution", () => {
    it("resolves a normal registered team's name and real team_id", async () => {
      const t = await makeStage();
      const players = await fx.players(2);
      const { teamId } = await makeRegisteredTeam(t.id, "Real Team Name", players);

      const m = await bareMatchWithLineups();
      await fx.lineupPlayer(m.lineup1Id, players[0]);
      await fx.lineupPlayer(m.lineup2Id, players[1]);
      await attachMatchToStage(t.stageIds[0], m.matchId);
      await fx.kill(m, players[0], players[1], { round: 1 });
      await fx.round(m.mapId, 1);

      const row = rowFor(await leaderboard(t.id), players[0]);
      expect(row.team_name).toBe("Real Team Name");
      expect(row.team_id).toBe(teamId);
    });

    it("resolves a Solo Random generated team's name with a null real team_id", async () => {
      const t = await makeStage();
      const players = await fx.players(2);
      await makeGeneratedTeam(t.id, "Team 1", players);

      const m = await bareMatchWithLineups();
      await fx.lineupPlayer(m.lineup1Id, players[0]);
      await fx.lineupPlayer(m.lineup2Id, players[1]);
      await attachMatchToStage(t.stageIds[0], m.matchId);
      await fx.kill(m, players[0], players[1], { round: 1 });
      await fx.round(m.mapId, 1);

      const row = rowFor(await leaderboard(t.id), players[0]);
      expect(row.team_name).toBe("Team 1");
      expect(row.team_id).toBeNull();
    });

    it("includes players whose team is still active (no elimination/finished gate)", async () => {
      const t = await makeStage();
      const players = await fx.players(2);
      await makeRegisteredTeam(t.id, "Still Playing", players);

      const m = await bareMatchWithLineups();
      await fx.lineupPlayer(m.lineup1Id, players[0]);
      await fx.lineupPlayer(m.lineup2Id, players[1]);
      await attachMatchToStage(t.stageIds[0], m.matchId);
      await fx.kill(m, players[0], players[1], { round: 1 });
      await fx.round(m.mapId, 1);
      // Deliberately not setting matches.winning_lineup_id / tournament_brackets.finished
      // -- this bracket entry is unresolved, i.e. the match is still "live".

      const rows = await leaderboard(t.id);
      expect(rows.map((r) => r.player_steam_id).sort()).toEqual(
        players.slice().sort(),
      );
    });
  });
});
