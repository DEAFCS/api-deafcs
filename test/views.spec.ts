import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Exercises the read-side SQL the app displays: the HLTV rating view, the
// clutch feed, the player ELO ledger view and profile aggregation
// (get_player_elo), team rank averages, team reputation, and the leaderboard
// entry points. These are pure reads — regressions produce wrong numbers, not
// errors, so nothing else would catch them.
describe("read-side views and aggregations (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournamentFx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ViewsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199950000000n);
    tournamentFx = new TournamentFixtures(postgres, fx);
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
    await postgres.query("DELETE FROM team_scrim_requests");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.seasons_enabled'",
    );
  });

  const T = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  describe("v_player_match_map_hltv", () => {
    it("computes per-round rates and the HLTV 2.0 rating from stored stats", async () => {
      const ctx = await fx.bareMatch();
      const [ace, victimOne, victimTwo] = await fx.players(3);

      await fx.kill(ctx, ace, victimOne, { round: 1, time: T(30) });
      await fx.kill(ctx, ace, victimTwo, { round: 1, time: T(29) });
      await fx.kill(ctx, ace, victimOne, { round: 2, time: T(20) });
      // Per-hit damage is capped at the victim's health by the recompute, so
      // stay under 100 per event.
      await fx.damage(ctx, ace, victimOne, 80, { round: 1 });
      await fx.damage(ctx, ace, victimTwo, 100, { round: 2 });
      await fx.round(ctx.mapId, 1, { time: T(25) });
      await fx.round(ctx.mapId, 2, { time: T(15) });

      const [row] = await postgres.query<
        Array<{
          rounds_played: number;
          kast_pct: string;
          hltv_rating: string;
          kpr: string;
          dpr: string;
          adr: string;
        }>
      >(
        "SELECT * FROM v_player_match_map_hltv WHERE match_map_id = $1 AND steam_id = $2",
        [ctx.mapId, ace],
      );

      expect(Number(row.rounds_played)).toBe(2);
      expect(Number(row.kpr)).toBeCloseTo(1.5, 3);
      expect(Number(row.dpr)).toBe(0);
      expect(Number(row.adr)).toBeCloseTo(90, 1);
      // Killed in both rounds: full KAST.
      expect(Number(row.kast_pct)).toBe(100);

      // Same formula the view encodes, from the same inputs.
      const kastPct = 100;
      const kpr = 3 / 2;
      const dpr = 0;
      const apr = 0;
      const adr = 180 / 2;
      const expectedRating =
        0.0073 * kastPct +
        0.3591 * kpr -
        0.5329 * dpr +
        0.2372 * (2.13 * kpr + 0.42 * apr - 0.41) +
        0.0032 * adr +
        0.1587;
      expect(Number(row.hltv_rating)).toBeCloseTo(
        Math.round(expectedRating * 100) / 100,
        2,
      );

      const [victimRow] = await postgres.query<
        Array<{ dpr: string; kast_pct: string }>
      >(
        "SELECT * FROM v_player_match_map_hltv WHERE match_map_id = $1 AND steam_id = $2",
        [ctx.mapId, victimOne],
      );
      // Died in both rounds without impact: 1.0 deaths per round, 0 KAST.
      expect(Number(victimRow.dpr)).toBeCloseTo(1, 3);
      expect(Number(victimRow.kast_pct)).toBe(0);
    });
  });

  describe("v_match_clutches", () => {
    it("surfaces detected clutches per finalized round", async () => {
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      const [a, b, c, d] = await fx.players(4);
      await fx.lineupPlayer(match.lineup_1_id, a);
      await fx.lineupPlayer(match.lineup_1_id, b);
      await fx.lineupPlayer(match.lineup_2_id, c);
      await fx.lineupPlayer(match.lineup_2_id, d);
      const [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [match.id],
      );
      const ctx = { matchId: match.id, mapId: map.id };

      await fx.kill(ctx, c, b, {
        round: 1,
        time: T(10),
        attackerTeam: "TERRORIST",
        victimTeam: "CT",
      });
      await fx.kill(ctx, a, c, {
        round: 1,
        time: T(9),
        attackerTeam: "CT",
        victimTeam: "TERRORIST",
      });
      await fx.kill(ctx, a, d, {
        round: 1,
        time: T(8),
        attackerTeam: "CT",
        victimTeam: "TERRORIST",
      });
      await fx.round(ctx.mapId, 1, { winningSide: "CT", time: T(7) });

      const clutches = await postgres.query<
        Array<{
          clutcher_steam_id: string;
          against_count: number;
          outcome: string;
          round: number;
        }>
      >("SELECT * FROM v_match_clutches WHERE match_id = $1", [match.id]);

      expect(clutches.length).toBe(1);
      expect(clutches[0]).toMatchObject({
        clutcher_steam_id: a,
        outcome: "won",
      });
      expect(Number(clutches[0].against_count)).toBe(2);
    });
  });

  // A finished 1v1 with ELO generated, reused by the ledger and profile tests.
  const ratedDuel = async (a: string, b: string, endedDaysAgo = 1) => {
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [match.id],
    );
    await postgres.query(
      "UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1",
      [match.id, endedDaysAgo],
    );
    await postgres.query("SELECT generate_player_elo_for_match($1)", [
      match.id,
    ]);
    return match;
  };

  describe("v_player_elo and get_player_elo", () => {
    it("the ledger view maps wins/losses and before/after ratings", async () => {
      const [a, b] = await fx.players(2);
      const match = await ratedDuel(a, b);

      const rows = await postgres.query<
        Array<{
          player_steam_id: string;
          match_result: string;
          current_elo: number;
          updated_elo: number;
          elo_change: number;
        }>
      >("SELECT * FROM v_player_elo WHERE match_id = $1", [match.id]);

      const winner = rows.find((r) => r.player_steam_id === a)!;
      const loser = rows.find((r) => r.player_steam_id === b)!;
      expect(winner.match_result).toBe("win");
      expect(loser.match_result).toBe("loss");
      // current_elo is the pre-match rating; updated_elo the post-match one.
      expect(Number(winner.current_elo)).toBe(5000);
      expect(Number(winner.updated_elo)).toBe(5000 + Number(winner.elo_change));
    });

    it("profile aggregation returns per-type ladders (seasons off)", async () => {
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b);

      const [profile] = await postgres.query<Array<{ elo: { duel: number } }>>(
        "SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1",
        [a],
      );
      expect(profile.elo.duel).toBeGreaterThan(5000);
      // Unplayed types default to the 5000 baseline (get_player_elo_by_type's
      // COALESCE(elo_value, 5000)) rather than staying null -- intentional,
      // documented production behavior (a null/blank rating was read as 0 by
      // matchmaking team balancing, making a brand-new player look like the
      // weakest possible player instead of an average one). This assertion
      // previously expected null, which was stale relative to that fix.
      expect(profile.elo).toMatchObject({ competitive: 5000, wingman: 5000 });
    });

    it("profile aggregation switches to season + tournament tracks (seasons on)", async () => {
      await fx.enableSeasons();
      await fx.season("2025-01-01", null); // active season covers now()
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b);

      const [profile] = await postgres.query<
        Array<{ elo: Record<string, number | null> }>
      >("SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1", [
        a,
      ]);
      expect(profile.elo.duel).toBeGreaterThan(5000); // active-season ladder
      expect(profile.elo.tournament_duel).toBeNull(); // no tournament matches yet
    });
  });

  describe("v_team_ranks", () => {
    it("averages the displayed rating sources across the roster, ignoring gaps", async () => {
      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1, p2] = roster.map((r) => r.player_steam_id);

      // Competitive elo rows for both (via the ledger the view actually reads).
      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $3, 'Competitive', 6000, 0, now() - interval '1 hour'),
                ($2, $3, 'Competitive', 4000, 0, now() - interval '1 hour')`,
        [p1, p2, matchId],
      );
      // Faceit data for only one player: the other must not drag the average.
      await postgres.query(
        "UPDATE players SET faceit_elo = 2000, faceit_skill_level = 8 WHERE steam_id = $1",
        [p1],
      );

      const [ranks] = await postgres.query<
        Array<{
          roster_size: number;
          avg_elo: number;
          min_elo: number;
          max_elo: number;
          avg_faceit_elo: number | null;
          avg_faceit_level: number | null;
        }>
      >("SELECT * FROM v_team_ranks WHERE team_id = $1", [team.id]);

      expect(Number(ranks.roster_size)).toBe(2);
      expect(Number(ranks.avg_elo)).toBe(5000);
      expect(Number(ranks.min_elo)).toBe(4000);
      expect(Number(ranks.max_elo)).toBe(6000);
      expect(Number(ranks.avg_faceit_elo)).toBe(2000);
      expect(Number(ranks.avg_faceit_level)).toBe(8);
    });

    it("active season: a player's older/lifetime Competitive row does not leak into avg_elo when they have none in the current season", async () => {
      await fx.enableSeasons();
      const oldSeasonId = await fx.season("2020-01-01", "2020-06-01");
      await fx.season("2020-06-01", null); // open-ended, contains now()

      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1] = roster.map((r) => r.player_steam_id);

      // p1 only has a row from the OLD (now closed) season -- must not count
      // toward the active-season average. p2 has no player_elo rows at all.
      const { matchId: oldMatch } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 6000, 0, now() - interval '1 hour', $3)`,
        [p1, oldMatch, oldSeasonId],
      );

      const [ranks] = await postgres.query<Array<{ avg_elo: number }>>(
        "SELECT avg_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Both players show the season-starting 5000 (p1's stale 6000 ignored).
      expect(Number(ranks.avg_elo)).toBe(5000);
    });

    it("active season: a player's current-season Competitive row is used as-is", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1] = roster.map((r) => r.player_steam_id);

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 5400, 0, now() - interval '1 hour', $3)`,
        [p1, matchId, activeSeasonId],
      );
      // p2 has no row -> 5000.

      const [ranks] = await postgres.query<Array<{ avg_elo: number }>>(
        "SELECT avg_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // (5400 + 5000) / 2 = 5200
      expect(Number(ranks.avg_elo)).toBe(5200);
    });

    it("active season: two roster players with no Competitive row anywhere reproduce the reported 5000 average", async () => {
      await fx.enableSeasons();
      await fx.season("2020-01-01", null);

      const team = await fx.team(1);

      const [ranks] = await postgres.query<Array<{ avg_elo: number }>>(
        "SELECT avg_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      expect(Number(ranks.avg_elo)).toBe(5000);
    });

    it("a coach's ELO does not influence the team average or roster_size", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1);
      const coach = await fx.player();
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status, coach) VALUES ($1, $2, 'Starter', true)",
          [team.id, coach],
        ),
      );

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 8000, 0, now() - interval '1 hour', $3)`,
        [coach, matchId, activeSeasonId],
      );

      const [ranks] = await postgres.query<
        Array<{ roster_size: number; avg_elo: number }>
      >("SELECT roster_size, avg_elo FROM v_team_ranks WHERE team_id = $1", [
        team.id,
      ]);

      // Both real players default to 5000 (no season row); the coach's 8000
      // must not be counted in roster_size or dragged into the average.
      expect(Number(ranks.roster_size)).toBe(2);
      expect(Number(ranks.avg_elo)).toBe(5000);
    });

    it("substitute and benched non-coach roster members are still included", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1); // owner + 1 starter mate, both default 5000
      const substitute = await fx.player();
      const benched = await fx.player();
      await runAsUser(postgres, team.owner, "admin", async (query) => {
        await query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Substitute')",
          [team.id, substitute],
        );
        await query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Benched')",
          [team.id, benched],
        );
      });

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Competitive', 6000, 0, now() - interval '1 hour', $3)`,
        [substitute, matchId, activeSeasonId],
      );
      // benched player has no row -> 5000.

      const [ranks] = await postgres.query<
        Array<{ roster_size: number; avg_elo: number }>
      >("SELECT roster_size, avg_elo FROM v_team_ranks WHERE team_id = $1", [
        team.id,
      ]);

      // 4 players total: owner 5000, mate 5000, substitute 6000, benched 5000
      // -> avg 5250.
      expect(Number(ranks.roster_size)).toBe(4);
      expect(Number(ranks.avg_elo)).toBe(5250);
    });

    it("seasons disabled: falls back to existing lifetime Competitive ELO behavior", async () => {
      // No fx.enableSeasons() call -- seasons are off by default per beforeEach.
      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1, p2] = roster.map((r) => r.player_steam_id);

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $3, 'Competitive', 6000, 0, now() - interval '1 hour'),
                ($2, $3, 'Competitive', 4000, 0, now() - interval '1 hour')`,
        [p1, p2, matchId],
      );

      const [ranks] = await postgres.query<Array<{ avg_elo: number }>>(
        "SELECT avg_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Lifetime-latest rows used directly, same as before this change.
      expect(Number(ranks.avg_elo)).toBe(5000);
    });

    it("active season: Wingman and Duel use each player's current-season row for that type independently of Competitive", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1] = roster.map((r) => r.player_steam_id);

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Wingman', 5800, 0, now() - interval '1 hour', $3),
                ($1, $2, 'Duel', 4600, 0, now() - interval '1 hour', $3)`,
        [p1, matchId, activeSeasonId],
      );
      // p1 has no Competitive row this season, p2 has no rows at all in any type.

      const [ranks] = await postgres.query<
        Array<{
          avg_elo: number;
          avg_wingman_elo: number;
          avg_duel_elo: number;
        }>
      >(
        "SELECT avg_elo, avg_wingman_elo, avg_duel_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Competitive: neither player has a row -> both default 5000 -> 5000.
      expect(Number(ranks.avg_elo)).toBe(5000);
      // Wingman: (5800 + 5000) / 2 = 5400.
      expect(Number(ranks.avg_wingman_elo)).toBe(5400);
      // Duel: (4600 + 5000) / 2 = 4800.
      expect(Number(ranks.avg_duel_elo)).toBe(4800);
    });

    it("active season: a player's older/lifetime Wingman row does not leak into avg_wingman_elo when they have none in the current season", async () => {
      await fx.enableSeasons();
      const oldSeasonId = await fx.season("2020-01-01", "2020-06-01");
      await fx.season("2020-06-01", null); // open-ended, contains now()

      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1] = roster.map((r) => r.player_steam_id);

      const { matchId: oldMatch } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Wingman', 6500, 0, now() - interval '1 hour', $3)`,
        [p1, oldMatch, oldSeasonId],
      );

      const [ranks] = await postgres.query<Array<{ avg_wingman_elo: number }>>(
        "SELECT avg_wingman_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Both players show the season-starting 5000 (p1's stale 6500 ignored).
      expect(Number(ranks.avg_wingman_elo)).toBe(5000);
    });

    it("a coach's ELO does not influence the Wingman or Duel team average", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1);
      const coach = await fx.player();
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status, coach) VALUES ($1, $2, 'Starter', true)",
          [team.id, coach],
        ),
      );

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Wingman', 9000, 0, now() - interval '1 hour', $3),
                ($1, $2, 'Duel', 9000, 0, now() - interval '1 hour', $3)`,
        [coach, matchId, activeSeasonId],
      );

      const [ranks] = await postgres.query<
        Array<{
          roster_size: number;
          avg_wingman_elo: number;
          avg_duel_elo: number;
        }>
      >(
        "SELECT roster_size, avg_wingman_elo, avg_duel_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Both real players default to 5000 (no season row); the coach's 9000
      // must not be counted in roster_size or dragged into either average.
      expect(Number(ranks.roster_size)).toBe(2);
      expect(Number(ranks.avg_wingman_elo)).toBe(5000);
      expect(Number(ranks.avg_duel_elo)).toBe(5000);
    });

    it("substitute and benched non-coach roster members are still included in Wingman/Duel averages", async () => {
      await fx.enableSeasons();
      const activeSeasonId = await fx.season("2020-01-01", null);

      const team = await fx.team(1); // owner + 1 starter mate, both default 5000
      const substitute = await fx.player();
      const benched = await fx.player();
      await runAsUser(postgres, team.owner, "admin", async (query) => {
        await query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Substitute')",
          [team.id, substitute],
        );
        await query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Benched')",
          [team.id, benched],
        );
      });

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, 'Duel', 7000, 0, now() - interval '1 hour', $3)`,
        [substitute, matchId, activeSeasonId],
      );
      // benched player has no row -> 5000.

      const [ranks] = await postgres.query<
        Array<{ roster_size: number; avg_duel_elo: number }>
      >(
        "SELECT roster_size, avg_duel_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // 4 players total: owner 5000, mate 5000, substitute 7000, benched 5000
      // -> avg 5500.
      expect(Number(ranks.roster_size)).toBe(4);
      expect(Number(ranks.avg_duel_elo)).toBe(5500);
    });

    it("seasons disabled: Wingman and Duel fall back to existing lifetime ELO behavior, same as Competitive", async () => {
      // No fx.enableSeasons() call -- seasons are off by default per beforeEach.
      const team = await fx.team(1);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
        [team.id],
      );
      const [p1, p2] = roster.map((r) => r.player_steam_id);

      const { matchId } = await fx.bareMatch(T(60));
      await postgres.query(
        `INSERT INTO player_elo (steam_id, match_id, type, "current", change, created_at)
         VALUES ($1, $3, 'Wingman', 6000, 0, now() - interval '1 hour'),
                ($2, $3, 'Wingman', 4000, 0, now() - interval '1 hour')`,
        [p1, p2, matchId],
      );

      const [ranks] = await postgres.query<Array<{ avg_wingman_elo: number }>>(
        "SELECT avg_wingman_elo FROM v_team_ranks WHERE team_id = $1",
        [team.id],
      );

      // Lifetime-latest rows used directly, same fallback as Competitive.
      expect(Number(ranks.avg_wingman_elo)).toBe(5000);
    });
  });

  describe("v_team_reputation", () => {
    const scrimRequest = async (
      fromTeam: { id: string; owner: string },
      toTeam: { id: string; owner: string },
    ) => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO team_scrim_requests
           (from_team_id, to_team_id, status, requested_by_steam_id, awaiting_team_id,
            proposed_scheduled_at, expires_at)
         VALUES ($1, $2, 'Matched', $3, $2, now() + interval '1 day', now() + interval '12 hours')
         RETURNING id`,
        [fromTeam.id, toTeam.id, fromTeam.owner],
      );
      return row.id;
    };

    const scrimMatch = async (
      teamA: { id: string },
      teamB: { id: string },
      requestId: string,
    ) => {
      const match = await fx.match({ type: "Wingman", mr: 8, mapVeto: true });
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamA.id, match.lineup_1_id],
      );
      await postgres.query(
        "UPDATE match_lineups SET team_id = $1 WHERE id = $2",
        [teamB.id, match.lineup_2_id],
      );
      await postgres.query(
        "UPDATE team_scrim_requests SET match_id = $1 WHERE id = $2",
        [match.id, requestId],
      );
      return match;
    };

    const reputation = async (teamId: string) => {
      const [row] = await postgres.query<
        Array<{
          scrims_completed: number;
          no_shows: number;
          late_cancels: number;
        }>
      >("SELECT * FROM v_team_reputation WHERE team_id = $1", [teamId]);
      return row;
    };

    it("counts completed scrims for both teams", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      const match = await scrimMatch(teamA, teamB, request);

      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [match.id],
      );

      expect(Number((await reputation(teamA.id)).scrims_completed)).toBe(1);
      expect(Number((await reputation(teamB.id)).scrims_completed)).toBe(1);
    });

    it("pins a no-show on the team that never checked in, even after match GC", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      const match = await scrimMatch(teamA, teamB, request);

      // Team A checked in; team B never showed. The match is canceled and
      // later garbage collected (deleted), leaving only the frozen snapshot.
      await postgres.query(
        `UPDATE match_lineup_players SET checked_in = true
         WHERE match_lineup_id = $1 AND steam_id = $2`,
        [match.lineup_1_id, teamA.owner],
      );
      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [match.id],
      );
      await postgres.query("DELETE FROM matches WHERE id = $1", [match.id]);

      expect(Number((await reputation(teamA.id)).no_shows)).toBe(0);
      expect(Number((await reputation(teamB.id)).no_shows)).toBe(1);
    });

    it("charges late cancels only to the team that bailed", async () => {
      const teamA = await fx.team(1);
      const teamB = await fx.team(1);
      const request = await scrimRequest(teamA, teamB);
      await scrimMatch(teamA, teamB, request);

      await postgres.query(
        `UPDATE team_scrim_requests
         SET status = 'Cancelled', canceled_late = true, canceled_by_team_id = $2
         WHERE id = $1`,
        [request, teamA.id],
      );

      expect(Number((await reputation(teamA.id)).late_cancels)).toBe(1);
      expect(Number((await reputation(teamB.id)).late_cancels)).toBe(0);
    });
  });

  describe("get_leaderboard", () => {
    type LeaderboardRow = {
      player_steam_id: string;
      value: number;
      secondary_value: number | null;
      tertiary_value: number | null;
      matches_played: number;
    };

    const leaderboard = (category: string, windowDays: number, type?: string) =>
      postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard($1, $2, $3)",
        [category, windowDays, type ?? null],
      );

    const eloLeaderboard = (
      windowDays: number,
      type: "Competitive" | "Wingman" | "Duel",
      view: "current" | "peak" = "current",
      excludeTournaments = false,
    ) =>
      postgres.query<Array<LeaderboardRow>>(
        "SELECT * FROM get_leaderboard('elo', $1, $2, $3, NULL, NULL, $4)",
        [windowDays, type, excludeTournaments, view],
      );

    const insertElo = async (
      steamId: string,
      matchId: string,
      type: "Competitive" | "Wingman" | "Duel",
      current: number,
      change: number,
      daysAgo: number,
      seasonId: string | null = null,
    ) => {
      await postgres.query(
        `INSERT INTO player_elo
           (steam_id, match_id, type, "current", change, created_at, season_id)
         VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6), $7)`,
        [steamId, matchId, type, current, change, daysAgo, seasonId],
      );
    };

    // A finished '5stack' match with a materialized map to hang kills on. The
    // stat categories inner-join match_options, so bareMatch (optionless, the
    // demo-import shape) would be invisible to them.
    //
    // `participants`, if given, are seeded into match_lineup_players (split
    // across both lineups) and the match is marked Finished -- required by
    // the participant-driven stat categories (KDR, HS%) so a player with no
    // kill/death row still shows up on the ladder. `endedAt` lets a caller
    // backdate the match to line up with backdated kill/death rows for
    // window-filter tests.
    const statMatch = async (
      participants: string[] = [],
      endedAt: string | null = null,
    ) => {
      const { poolId } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId });
      const half = Math.ceil(participants.length / 2);
      for (const [i, steamId] of participants.entries()) {
        await fx.lineupPlayer(
          i < half ? match.lineup_1_id : match.lineup_2_id,
          steamId,
        );
      }
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      if (participants.length > 0) {
        // Two updates: the tbi_matches trigger forces ended_at = NOW() on
        // the status transition into 'Finished' itself, so a custom
        // endedAt must be applied in a separate statement afterward (same
        // pattern as the ratedDuel helper above).
        await postgres.query(
          "UPDATE matches SET status = 'Finished' WHERE id = $1",
          [match.id],
        );
        await postgres.query("UPDATE matches SET ended_at = $2 WHERE id = $1", [
          match.id,
          endedAt ?? new Date().toISOString(),
        ]);
      }
      return { match, ctx: { matchId: match.id, mapId: map.id } };
    };

    it("ranks the elo ladder and per-player stats categories", async () => {
      const [a, b] = await fx.players(2);
      await ratedDuel(a, b, 2);
      await ratedDuel(a, b, 1); // a wins twice: clearly ahead

      const elo = await leaderboard("elo", 30, "Duel");
      expect(elo.length).toBe(2);
      expect(elo[0].player_steam_id).toBe(a);
      expect(Number(elo[0].value)).toBeGreaterThan(Number(elo[1].value));
    });

    it.each(["Competitive", "Wingman", "Duel"] as const)(
      "separates current and peak %s ladders and uses the latest change for current",
      async (type) => {
        const [formerLeader, currentLeader] = await fx.players(2);
        const oldPeakMatch = await fx.bareMatch(T(60 * 24 * 10));
        const latestMatch = await fx.bareMatch(T(60 * 24));

        await insertElo(
          formerLeader,
          oldPeakMatch.matchId,
          type,
          6200,
          1200,
          10,
        );
        await insertElo(formerLeader, latestMatch.matchId, type, 5896, -304, 1);
        await insertElo(
          currentLeader,
          latestMatch.matchId,
          type,
          6110,
          1110,
          1,
        );

        const current = await eloLeaderboard(0, type);
        expect(current.map((row) => row.player_steam_id)).toEqual([
          currentLeader,
          formerLeader,
        ]);
        expect(Number(current[0].value)).toBe(6110);
        expect(Number(current[1].value)).toBe(5896);
        expect(Number(current[1].secondary_value)).toBe(-304);

        const peak = await eloLeaderboard(0, type, "peak");
        expect(peak.map((row) => row.player_steam_id)).toEqual([
          formerLeader,
          currentLeader,
        ]);
        expect(Number(peak[0].value)).toBe(6200);
        // secondary_value under Peak is now All Time's Current ELO (the
        // active named season's rating), not a placeholder 0 -- no season
        // exists in this test, so it's the 5000 default.
        expect(Number(peak[0].secondary_value)).toBe(5000);

        const [currentRank] = await postgres.query<
          Array<{ rank: number; total: number; value: number }>
        >(
          `SELECT * FROM get_player_leaderboard_rank(
             'elo', 0, $1, $2, false, NULL, 'current'
           )`,
          [currentLeader, type],
        );
        const [peakRank] = await postgres.query<
          Array<{ rank: number; total: number; value: number }>
        >(
          `SELECT * FROM get_player_leaderboard_rank(
             'elo', 0, $1, $2, false, NULL, 'peak'
           )`,
          [formerLeader, type],
        );
        expect(Number(currentRank.rank)).toBe(1);
        expect(Number(currentRank.total)).toBe(2);
        expect(Number(currentRank.value)).toBe(6110);
        expect(Number(peakRank.rank)).toBe(1);
        expect(Number(peakRank.value)).toBe(6200);
      },
    );

    it("uses accumulated net change for rolling windows and excludes inactive players", async () => {
      const [gainer, flat, loser, inactive] = await fx.players(4);
      const oldMatch = await fx.bareMatch(T(60 * 24 * 40));
      const sixDayMatch = await fx.bareMatch(T(60 * 24 * 6));
      const threeDayMatch = await fx.bareMatch(T(60 * 24 * 3));
      const latestMatch = await fx.bareMatch(T(60 * 24));

      await insertElo(gainer, sixDayMatch.matchId, "Duel", 6000, 50, 6);
      await insertElo(gainer, latestMatch.matchId, "Duel", 6110, 110, 1);
      await insertElo(flat, threeDayMatch.matchId, "Duel", 5800, 0, 3);
      await insertElo(loser, threeDayMatch.matchId, "Duel", 5900, -50, 3);
      await insertElo(inactive, oldMatch.matchId, "Duel", 6300, 1300, 40);

      for (const days of [7, 30]) {
        const rows = await eloLeaderboard(days, "Duel");
        const byId = new Map(rows.map((row) => [row.player_steam_id, row]));
        expect(byId.has(inactive)).toBe(false);
        expect(Number(byId.get(gainer)!.value)).toBe(6110);
        expect(Number(byId.get(gainer)!.secondary_value)).toBe(160);
        expect(Number(byId.get(flat)!.secondary_value)).toBe(0);
        expect(Number(byId.get(loser)!.secondary_value)).toBe(-50);

        const byChange = [...rows].sort(
          (a, b) => Number(b.secondary_value) - Number(a.secondary_value),
        );
        expect(byChange.map((row) => Number(row.secondary_value))).toEqual([
          160, 0, -50,
        ]);
      }
    });

    // Rolling-window ELO Change must be the SUM of every eligible match's own
    // change inside the window, not "latest ELO minus the ELO immediately
    // before the window's first row." The old formula silently collapsed to
    // whatever happened right before the window's first match, so a season
    // reset to 5000 sitting inside the window made the 7-day and 30-day
    // figures equal even though the 30-day window covered an extra,
    // pre-reset match. These cases reproduce that production scenario
    // (7 Days: +289, 30 Days: +544, matching the m0c1n Wingman evidence) and
    // the surrounding edge cases called out in the fix's requirements.
    describe("rolling-window ELO Change", () => {
      it("sums changes across a mid-window season reset instead of collapsing to the post-reset baseline", async () => {
        const [player] = await fx.players(1);
        const seasonOne = await fx.season("2020-01-01", "2020-06-01");
        const seasonTwo = await fx.season("2020-06-01", null);

        const preResetMatch = await fx.bareMatch(T(60 * 24 * 10));
        const resetMatchA = await fx.bareMatch(T(60 * 24 * 5));
        const resetMatchB = await fx.bareMatch(T(60 * 24 * 1));

        // Pre-reset: outside the 7-day window, inside the 30-day window.
        await insertElo(
          player,
          preResetMatch.matchId,
          "Wingman",
          5255,
          255,
          10,
          seasonOne,
        );
        // Post-reset: inside both windows.
        await insertElo(
          player,
          resetMatchA.matchId,
          "Wingman",
          5100,
          100,
          5,
          seasonTwo,
        );
        await insertElo(
          player,
          resetMatchB.matchId,
          "Wingman",
          5289,
          189,
          1,
          seasonTwo,
        );

        const [sevenDay] = await eloLeaderboard(7, "Wingman");
        const [thirtyDay] = await eloLeaderboard(30, "Wingman");

        expect(Number(sevenDay.value)).toBe(5289);
        expect(Number(sevenDay.secondary_value)).toBe(289);
        expect(Number(thirtyDay.value)).toBe(5289);
        expect(Number(thirtyDay.secondary_value)).toBe(544);
        expect(Number(thirtyDay.secondary_value)).not.toBe(
          Number(sevenDay.secondary_value),
        );
      });

      it("sums positive and negative changes together", async () => {
        const [player] = await fx.players(1);
        const winMatch = await fx.bareMatch(T(60 * 24 * 4));
        const lossMatch = await fx.bareMatch(T(60 * 24 * 2));

        await insertElo(player, winMatch.matchId, "Duel", 5150, 150, 4);
        await insertElo(player, lossMatch.matchId, "Duel", 5090, -60, 2);

        const [row] = await eloLeaderboard(7, "Duel");
        expect(Number(row.secondary_value)).toBe(90);
      });

      it("omits players with no matches in the window", async () => {
        const [player] = await fx.players(1);
        const oldMatch = await fx.bareMatch(T(60 * 24 * 20));
        await insertElo(player, oldMatch.matchId, "Duel", 5300, 300, 20);

        const rows = await eloLeaderboard(7, "Duel");
        expect(rows.find((r) => r.player_steam_id === player)).toBeUndefined();
      });

      it("sums to exactly that match's own change when only one match falls in the window", async () => {
        const [player] = await fx.players(1);
        const match = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, match.matchId, "Duel", 5075, 75, 2);

        const [row] = await eloLeaderboard(30, "Duel");
        expect(Number(row.secondary_value)).toBe(75);
      });

      it("keeps rolling sums isolated per match type", async () => {
        const [player] = await fx.players(1);
        const wingmanMatch = await fx.bareMatch(T(60 * 24 * 2));
        const duelMatch = await fx.bareMatch(T(60 * 24 * 1));

        await insertElo(player, wingmanMatch.matchId, "Wingman", 5200, 200, 2);
        await insertElo(player, duelMatch.matchId, "Duel", 5040, 40, 1);

        const [wingmanRow] = await eloLeaderboard(30, "Wingman");
        const [duelRow] = await eloLeaderboard(30, "Duel");
        expect(Number(wingmanRow.secondary_value)).toBe(200);
        expect(Number(duelRow.secondary_value)).toBe(40);
      });

      it("includes tournament-sourced changes in the rolling sum regardless of the Exclude Tournaments toggle", async () => {
        // Canonical ELO: match source is metadata, not a separate ladder, so
        // a tournament-linked player_elo row contributes to the rolling sum
        // the same as a regular one, and the (now vestigial-for-ELO)
        // Exclude Tournaments flag makes no difference here. A single-
        // elimination stage needs at least 4 teams (see TournamentFixtures.
        // createTournament's stage validation, exercised the same way in
        // elo.spec.ts's tournament tests).
        const tournament = await tournamentFx.launch(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
          4,
        );
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;
        expect(bracket.match_id).not.toBeNull();

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, regularMatch.matchId, "Wingman", 5050, 50, 2);
        await insertElo(player, bracket.match_id!, "Wingman", 5150, 100, 1);

        const [includedRow] = await eloLeaderboard(7, "Wingman", "current", false);
        const [excludedRow] = await eloLeaderboard(7, "Wingman", "current", true);

        expect(Number(includedRow.secondary_value)).toBe(150);
        expect(Number(includedRow.value)).toBe(5150);
        expect(Number(excludedRow.secondary_value)).toBe(150);
        expect(Number(excludedRow.value)).toBe(5150);
      });

      it("leaves named-season ELO Change on the existing final-minus-starting formula", async () => {
        // This must be unambiguously a COMPLETED season -- both starts_at
        // and ends_at in the past -- not an open-ended/active one. An
        // active named season now reports Last Match (the latest row's own
        // change) for secondary_value; only a completed season keeps the
        // final-minus-starting formula this test targets.
        const [player] = await fx.players(1);
        const seasonStart = new Date(
          Date.now() - 60 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const seasonEnd = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const seasonId = await fx.season(seasonStart, seasonEnd);
        // Both matches fall inside [seasonStart, seasonEnd) -- 45 and 35
        // days ago are both between the 60-day start and the 30-day end.
        const first = await fx.bareMatch(T(60 * 24 * 45));
        const second = await fx.bareMatch(T(60 * 24 * 35));

        await insertElo(player, first.matchId, "Competitive", 5200, 200, 45, seasonId);
        await insertElo(
          player,
          second.matchId,
          "Competitive",
          5150,
          -50,
          35,
          seasonId,
        );

        const [row] = await postgres.query<Array<LeaderboardRow>>(
          `SELECT * FROM get_leaderboard(
             'elo', 0, 'Competitive', false, NULL, $1, 'current'
           )`,
          [seasonId],
        );
        // Season path: final (5150) minus starting-of-season (5200 - 200 =
        // 5000) = 150 — unaffected by the rolling-window SUM change.
        expect(Number(row.value)).toBe(5150);
        expect(Number(row.secondary_value)).toBe(150);
      });

      it("leaves unbounded Current's secondary_value as the latest match's own change", async () => {
        const [player] = await fx.players(1);
        const first = await fx.bareMatch(T(60 * 24 * 3));
        const second = await fx.bareMatch(T(60 * 24 * 1));
        await insertElo(player, first.matchId, "Duel", 5200, 200, 3);
        await insertElo(player, second.matchId, "Duel", 5150, -50, 1);

        const [row] = await eloLeaderboard(0, "Duel");
        expect(Number(row.value)).toBe(5150);
        expect(Number(row.secondary_value)).toBe(-50);
      });

      it("leaves Peak's value (rolling-window SUM fix doesn't touch it) and defaults its Current ELO with no active season", async () => {
        const [player] = await fx.players(1);
        const match = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, match.matchId, "Duel", 5300, 300, 2);

        const [row] = await eloLeaderboard(0, "Duel", "peak");
        expect(Number(row.value)).toBe(5300);
        // secondary_value under Peak is All Time's Current ELO; no season
        // exists in this test, so it's the 5000 default, not a placeholder 0.
        expect(Number(row.secondary_value)).toBe(5000);
      });

      it("does not double-count when a player has several matches inside the window", async () => {
        const [player] = await fx.players(1);
        const matches = await Promise.all([
          fx.bareMatch(T(60 * 24 * 6)),
          fx.bareMatch(T(60 * 24 * 4)),
          fx.bareMatch(T(60 * 24 * 2)),
        ]);
        const changes = [40, -15, 60]; // sum = 85
        for (const [i, m] of matches.entries()) {
          await insertElo(
            player,
            m.matchId,
            "Duel",
            5000 + changes.slice(0, i + 1).reduce((a, b) => a + b, 0),
            changes[i],
            6 - i * 2,
          );
        }

        const [row] = await eloLeaderboard(30, "Duel");
        expect(Number(row.secondary_value)).toBe(85);
      });
    });

    // CANONICAL ELO: there is exactly one ELO stream per player + mode +
    // configured ELO season, fed by every eligible source (matchmaking,
    // tournament, league) alike. A tournament-linked player_elo row is no
    // longer written with season_id = NULL / read as a separate "tournament
    // track" -- it carries the same season_id a regular match would, and is
    // indistinguishable to every read below. The Exclude Tournaments flag
    // therefore no longer changes any ELO leaderboard value: value,
    // secondary_value, tertiary_value, and matches_played are always
    // computed from the full canonical stream. Source filtering remains
    // meaningful (and unchanged) for the OTHER leaderboard categories
    // (best_kdr, best_win_rate, etc.) tested further below.
    describe("canonical ELO (source-unified, Exclude Tournaments is a no-op for ELO)", () => {
      const insertEloAt = async (
        steamId: string,
        matchId: string,
        type: "Competitive" | "Wingman" | "Duel",
        current: number,
        change: number,
        createdAt: string,
        seasonId: string | null = null,
      ) => {
        await postgres.query(
          `INSERT INTO player_elo
             (steam_id, match_id, type, "current", change, created_at, season_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [steamId, matchId, type, current, change, createdAt, seasonId],
        );
      };

      const seasonElo = (
        seasonId: string,
        type: "Competitive" | "Wingman" | "Duel" = "Wingman",
        excludeTournaments = false,
      ) =>
        postgres.query<Array<LeaderboardRow>>(
          `SELECT * FROM get_leaderboard('elo', 0, $2, $3, NULL, $1, 'current')`,
          [seasonId, type, excludeTournaments],
        );

      const launchTournament = (type: "Competitive" | "Wingman" | "Duel" = "Wingman") =>
        tournamentFx.launch(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
          4,
          type,
        );

      it("1. an active named season's Current/Last-Match reads a tournament-linked row exactly like a regular one", async () => {
        const seasonId = await fx.season("2020-01-01", null); // open-ended => active
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        // Both rows carry the SAME real season_id -- this is what the fixed
        // write path (generate_player_elo_for_match) now produces for a
        // tournament match played during an active season.
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 5350, 250, 1, seasonId);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5350); // latest row's own current, no adjustment math
        expect(Number(row.secondary_value)).toBe(250); // Last Match
        expect(Number(row.matches_played)).toBe(2);
      });

      it("2. Exclude Tournaments does not change the active season's ELO value, Last Match, or matches_played", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 5350, 250, 1, seasonId);

        const [includedRow] = await seasonElo(seasonId, "Wingman", false);
        const [excludedRow] = await seasonElo(seasonId, "Wingman", true);
        expect(Number(includedRow.value)).toBe(Number(excludedRow.value));
        expect(Number(includedRow.secondary_value)).toBe(
          Number(excludedRow.secondary_value),
        );
        expect(Number(includedRow.matches_played)).toBe(
          Number(excludedRow.matches_played),
        );
      });

      it("3. rank is identical whether or not Exclude Tournaments is set", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [leader, chaser] = await fx.players(2);
        const leaderMatch = await fx.bareMatch();
        const chaserMatch = await fx.bareMatch();
        await insertElo(leader, leaderMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(chaser, chaserMatch.matchId, "Wingman", 5150, 150, 3, seasonId);
        await insertElo(leader, bracket.match_id!, "Wingman", 5300, 200, 1, seasonId);

        const [includedRank] = await postgres.query<Array<{ rank: number }>>(
          `SELECT * FROM get_player_leaderboard_rank('elo', 0, $1, 'Wingman', false, $2, 'current')`,
          [leader, seasonId],
        );
        const [excludedRank] = await postgres.query<Array<{ rank: number }>>(
          `SELECT * FROM get_player_leaderboard_rank('elo', 0, $1, 'Wingman', true, $2, 'current')`,
          [leader, seasonId],
        );
        expect(Number(includedRank.rank)).toBe(1);
        expect(Number(excludedRank.rank)).toBe(1);
      });

      it("4. Peak ELO reflects a tournament-driven high regardless of the toggle", async () => {
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;
        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 2);
        await insertElo(player, bracket.match_id!, "Wingman", 6500, 1400, 1);

        const [included] = await eloLeaderboard(0, "Wingman", "peak", false);
        const [excluded] = await eloLeaderboard(0, "Wingman", "peak", true);
        expect(Number(included.value)).toBe(6500);
        expect(Number(excluded.value)).toBe(6500);
      });

      it("5. win/record streak counts a tournament win regardless of the toggle", async () => {
        const finishedMatch = async (
          type: "Competitive" | "Wingman" | "Duel",
          winner: string,
          loser: string,
          endedAt: string,
        ) => {
          const match = await fx.match({ type });
          await fx.lineupPlayer(match.lineup_1_id, winner);
          await fx.lineupPlayer(match.lineup_2_id, loser);
          await postgres.query(
            `UPDATE matches
               SET winning_lineup_id = lineup_1_id, status = 'Finished', ended_at = $2
             WHERE id = $1`,
            [match.id, endedAt],
          );
          return match;
        };

        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;
        await tournamentFx.winMatch(bracket.match_id!);
        await postgres.query("UPDATE matches SET status = 'Finished' WHERE id = $1", [
          bracket.match_id,
        ]);
        const [winner] = await postgres.query<Array<{ steam_id: string }>>(
          `SELECT mlp.steam_id
             FROM matches m
             JOIN match_lineup_players mlp ON mlp.match_lineup_id = m.winning_lineup_id
            WHERE m.id = $1
            LIMIT 1`,
          [bracket.match_id],
        );
        const [opp] = await fx.players(1);
        const regularWin = await finishedMatch(
          "Wingman",
          winner.steam_id,
          opp,
          T(60 * 24 * 1),
        );
        await insertElo(winner.steam_id, regularWin.id, "Wingman", 5200, 100, 1);
        await insertElo(winner.steam_id, bracket.match_id!, "Wingman", 9999, 100, 2);

        const [included] = await eloLeaderboard(0, "Wingman", "peak", false);
        const [excluded] = await eloLeaderboard(0, "Wingman", "peak", true);
        expect(Number(included.tertiary_value)).toBe(2); // tournament win + regular win
        expect(Number(excluded.tertiary_value)).toBe(2); // same -- no longer excludable
      });

      it("6. matches_played counts a tournament-linked row regardless of the toggle", async () => {
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;
        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 2);
        await insertElo(player, bracket.match_id!, "Wingman", 5200, 100, 1);

        const [included] = await eloLeaderboard(0, "Wingman", "peak", false);
        const [excluded] = await eloLeaderboard(0, "Wingman", "peak", true);
        expect(Number(included.matches_played)).toBe(2);
        expect(Number(excluded.matches_played)).toBe(2);
      });

      it("7. a player whose only activity this season came from a tournament match still starts from the 5000 baseline", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        // A tournament-only player's row now carries the real season_id
        // (unlike the old season_id = NULL write), so they surface via the
        // ordinary season-scoped lookup with no special-case union needed.
        await insertElo(player, bracket.match_id!, "Wingman", 5300, 300, 1, seasonId);

        const [row] = await seasonElo(seasonId);
        expect(row).toBeDefined();
        expect(Number(row.value)).toBe(5300);
        expect(Number(row.matches_played)).toBe(1);
      });

      it("8. a completed season's final-minus-starting ELO Change is unaffected by tournament-linked rows", async () => {
        const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const end = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        const seasonId = await fx.season(start, end);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const first = await fx.bareMatch();
        const second = await fx.bareMatch();
        await insertElo(player, first.matchId, "Wingman", 5200, 200, 20, seasonId);
        await insertElo(player, second.matchId, "Wingman", 5150, -50, 10, seasonId);
        // Must be the LATEST row for "value" to land on it -- i.e. fewer
        // days ago than `second` (10), not more. Using 15 here previously
        // made this row chronologically EARLIER than `second`, so the
        // (correct) latest-row lookup picked up `second`'s 5150 instead.
        const insideWindow = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        await insertEloAt(player, bracket.match_id!, "Wingman", 5400, 250, insideWindow, seasonId);

        const [row] = await seasonElo(seasonId);
        // Final (5400) minus starting-of-season (5200 - 200 = 5000) = 400.
        expect(Number(row.value)).toBe(5400);
        expect(Number(row.secondary_value)).toBe(400);
      });

      it("9. tournament eligibility for one match type never leaks into another", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Duel");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        // A Duel tournament row, even with a real season_id, must not
        // surface on the Wingman leaderboard row.
        await insertElo(player, bracket.match_id!, "Duel", 5500, 500, 1, seasonId);

        const [row] = await seasonElo(seasonId, "Wingman");
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.matches_played)).toBe(1);
      });
    });

    it("preserves canonical ELO across matchmaking and tournament sources: no adjustment math, one unified value", async () => {
      // A single-elimination first stage needs >= 4 teams: tournament_stages'
      // BEFORE INSERT/UPDATE validation trigger rejects min_teams < 4 * groups
      // (hasura/triggers/tournament_stages.sql), and `groups` defaults to 1,
      // so anything below 4 raises "First stage must have at least 4 teams".
      const tournament = await tournamentFx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        4,
      );
      const [bracket] = (
        await tournamentFx.getBrackets(tournament.stageIds[0])
      ).filter((b) => b.round === 1);
      expect(bracket.match_id).not.toBeNull();

      const [player] = await fx.players(1);
      const regularMatch = await fx.bareMatch(T(60 * 24 * 2));
      await insertElo(player, regularMatch.matchId, "Wingman", 5000, 0, 2);
      await insertElo(player, bracket.match_id!, "Wingman", 5100, 100, 1);

      const [includedCurrent] = await eloLeaderboard(0, "Wingman", "current", false);
      const [excludedCurrent] = await eloLeaderboard(0, "Wingman", "current", true);
      const [includedPeak] = await eloLeaderboard(0, "Wingman", "peak", false);
      const [excludedPeak] = await eloLeaderboard(0, "Wingman", "peak", true);

      // Every view agrees: 5100 is simply the latest/highest row, no matter
      // which source produced it or how the (now inert, for ELO) Exclude
      // Tournaments flag is set.
      expect(Number(includedCurrent.value)).toBe(5100);
      expect(Number(includedCurrent.secondary_value)).toBe(100);
      expect(Number(excludedCurrent.value)).toBe(5100);
      expect(Number(includedPeak.value)).toBe(5100);
      expect(Number(excludedPeak.value)).toBe(5100);
    });

    it("best_kdr divides kills by deaths, falling back to kill count for the deathless, and keeps zero-kill participants at value 0", async () => {
      const [ace, feeder, cleaner, target] = await fx.players(4);
      const { ctx } = await statMatch([ace, feeder, cleaner, target]);
      for (const round of [1, 2, 3]) {
        await fx.kill(ctx, ace, feeder, { round });
      }
      await fx.kill(ctx, feeder, ace);
      await fx.kill(ctx, cleaner, target);
      await fx.kill(ctx, cleaner, target, { round: 2 });

      const rows = await leaderboard("best_kdr", 30, "Competitive");
      // ace 3/1, cleaner deathless (value = raw kill count 2), feeder 1/3,
      // target never got a kill but IS a participant: 0 kills / 2 deaths = 0.
      expect(rows.map((r) => r.player_steam_id)).toEqual([
        ace,
        cleaner,
        feeder,
        target,
      ]);
      const byId = new Map(rows.map((r) => [r.player_steam_id, r]));
      expect(Number(byId.get(ace)!.value)).toBe(3);
      expect(Number(byId.get(ace)!.secondary_value)).toBe(3); // kills
      expect(Number(byId.get(ace)!.tertiary_value)).toBe(1); // deaths
      expect(Number(byId.get(cleaner)!.value)).toBe(2);
      expect(Number(byId.get(cleaner)!.tertiary_value)).toBe(0);
      expect(Number(byId.get(feeder)!.value)).toBeCloseTo(0.33, 2);
      // Never got a kill, but participated: shown at 0, not dropped.
      expect(Number(byId.get(target)!.value)).toBe(0);
      expect(Number(byId.get(target)!.secondary_value)).toBe(0); // kills
      expect(Number(byId.get(target)!.tertiary_value)).toBe(2); // deaths
    });

    it("best_win_rate is the finished-match win percentage with win/loss detail", async () => {
      const [champ, rival] = await fx.players(2);
      await ratedDuel(champ, rival); // ratedDuel: first player wins
      await ratedDuel(champ, rival);
      await ratedDuel(rival, champ);

      const rows = await leaderboard("best_win_rate", 30, "Duel");
      expect(rows.map((r) => r.player_steam_id)).toEqual([champ, rival]);
      const [top, bottom] = rows;
      expect(Number(top.value)).toBeCloseTo(66.67, 2);
      expect(Number(top.secondary_value)).toBe(2); // wins
      expect(Number(top.tertiary_value)).toBe(1); // losses
      expect(Number(top.matches_played)).toBe(3);
      expect(Number(bottom.value)).toBeCloseTo(33.33, 2);
    });

    it("highest_hs_pct ranks headshot ratios from the kill feed, keeping the zero-kill victim at 0%", async () => {
      const [surgeon, sprayer, victim] = await fx.players(3);
      const { ctx } = await statMatch([surgeon, sprayer, victim]);
      await fx.kill(ctx, surgeon, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 2 });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 3 });

      const rows = await leaderboard("highest_hs_pct", 30, "Competitive");
      // victim never lands a kill but did participate: shown at 0%, not dropped.
      expect(rows.map((r) => r.player_steam_id)).toEqual([
        surgeon,
        sprayer,
        victim,
      ]);
      expect(Number(rows[0].value)).toBe(100);
      expect(Number(rows[0].secondary_value)).toBe(1); // total kills
      expect(Number(rows[1].value)).toBeCloseTo(33.33, 2);
      expect(Number(rows[1].secondary_value)).toBe(3);
      expect(Number(rows[2].value)).toBe(0);
      expect(Number(rows[2].secondary_value)).toBe(0);
    });

    it("best_rating/best_adr/best_kpr/best_kast/best_udr surface a 9-round Duel match with no minimum-rounds floor", async () => {
      // A Duel (1v1) match, 9 rounds -- a completed match, but far short of
      // the removed `HAVING SUM(rounds_played) >= 50` floor that was sized
      // for a 5v5 map and previously emptied these leaderboards for
      // Duel/Wingman and early-season data.
      const { poolId } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId, type: "Duel" });
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      const ctx = { matchId: match.id, mapId: map.id };
      const [ace, opponent] = await fx.players(2);
      for (let round = 1; round <= 9; round++) {
        await fx.kill(ctx, ace, opponent, { round, time: T(60 - round) });
        await fx.damage(ctx, ace, opponent, 90, { round });
        await fx.round(ctx.mapId, round, { time: T(59 - round) });
      }

      const rating = await leaderboard("best_rating", 30, "Duel");
      const adr = await leaderboard("best_adr", 30, "Duel");
      const kpr = await leaderboard("best_kpr", 30, "Duel");
      const kast = await leaderboard("best_kast", 30, "Duel");
      const udr = await leaderboard("best_udr", 30, "Duel");

      for (const rows of [rating, adr, kpr, kast, udr]) {
        expect(rows.map((r) => r.player_steam_id)).toContain(ace);
      }
      const aceRating = rating.find((r) => r.player_steam_id === ace)!;
      // tertiary_value is rounds played: 9, well under the old 50-round floor.
      expect(Number(aceRating.tertiary_value)).toBe(9);
      const aceAdr = adr.find((r) => r.player_steam_id === ace)!;
      expect(Number(aceAdr.value)).toBeCloseTo(90, 1);
    });

    it("stat categories respect the day window, with 0 meaning all time -- and no longer drop the zero-kill participant", async () => {
      const [a, b] = await fx.players(2);
      const oldTime = T(60 * 24 * 40); // 40 days back
      const { ctx } = await statMatch([a, b], oldTime);
      await fx.kill(ctx, a, b, { time: oldTime });

      expect((await leaderboard("best_kdr", 30, "Competitive")).length).toBe(0);
      // All-time: both participants surface now, including b (0 kills).
      expect((await leaderboard("best_kdr", 0, "Competitive")).length).toBe(2);
    });

    it("get_player_leaderboard_rank locates a player inside the ladder", async () => {
      const [champ, rival] = await fx.players(2);
      await ratedDuel(champ, rival);

      const [rank] = await postgres.query<
        Array<{ rank: number; total: number; value: number }>
      >("SELECT * FROM get_player_leaderboard_rank('elo', 30, $1, 'Duel')", [
        rival,
      ]);
      expect(Number(rank.rank)).toBe(2);
      expect(Number(rank.total)).toBe(2);
    });

    it("rejects unknown categories loudly instead of returning an empty ladder", async () => {
      await expect(
        postgres.query("SELECT * FROM get_leaderboard('bogus', 30, NULL)"),
      ).rejects.toThrow(/Invalid category/);
    });

    // Overall / Matchmaking / Tournament / League. Classifies matches using
    // only existing relationships (tournament_brackets -> tournament_stages
    // -> league_season_divisions), no schema changes. For ELO, `value` must
    // stay canonical/source-invariant -- only the contribution columns
    // (secondary_value / matches_played) and row membership may change.
    describe("Source filter (Overall/Matchmaking/Tournament/League)", () => {
      const leaderboardSource = (
        category: string,
        windowDays: number,
        type: string | null,
        source: string,
      ) =>
        postgres.query<Array<LeaderboardRow>>(
          `SELECT * FROM get_leaderboard($1, $2, $3, false, NULL, NULL, 'current', $4)`,
          [category, windowDays, type, source],
        );

      // Fabricates a tournament-linked match without running the full
      // registration/scheduling flow -- tournament_brackets.match_id and
      // (for league) league_season_divisions.tournament_id are the only
      // relationships _leaderboard_match_source actually reads.
      const attachTournamentBracket = async (
        matchId: string,
        { league = false }: { league?: boolean } = {},
      ) => {
        const tournament = await tournamentFx.createTournament([
          { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
        ]);
        await postgres.query(
          `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
           VALUES ($1, $2, 1)`,
          [tournament.stageIds[0], matchId],
        );
        let leagueSeasonId: string | null = null;
        if (league) {
          // tier has a UNIQUE constraint, and the leagues migration seeds 4
          // default divisions (Invite=1, Main=2, Intermediate=3, Open=4)
          // into every freshly-migrated test DB -- a hardcoded tier here
          // collides with that seed data. Compute the next free tier
          // instead, so this fixture is correct regardless of what's
          // already seeded.
          const [division] = await postgres.query<Array<{ id: string }>>(
            `INSERT INTO league_divisions (name, tier)
             SELECT $1, COALESCE(MAX(tier), 0) + 1 FROM league_divisions
             RETURNING id`,
            [fx.nextName("division")],
          );
          const [season] = await postgres.query<Array<{ id: string }>>(
            `INSERT INTO league_seasons (name) VALUES ($1) RETURNING id`,
            [fx.nextName("season")],
          );
          leagueSeasonId = season.id;
          await postgres.query(
            `INSERT INTO league_season_divisions
               (league_season_id, league_division_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [season.id, division.id, tournament.id],
          );
        }
        return { ...tournament, leagueSeasonId };
      };

      it("rejects an unknown source loudly", async () => {
        await expect(
          postgres.query(
            "SELECT * FROM get_leaderboard('elo', 30, 'Duel', false, NULL, NULL, 'current', 'bogus')",
          ),
        ).rejects.toThrow(/Invalid source/);
      });

      it("keeps ELO value identical across Overall/Matchmaking/Tournament/League for the same player", async () => {
        const [player] = await fx.players(1);
        const mmMatch = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, mmMatch.matchId, "Duel", 5050, 50, 2);

        const tourneyMatch = await fx.bareMatch(T(60 * 24 * 1));
        await attachTournamentBracket(tourneyMatch.matchId);
        await insertElo(player, tourneyMatch.matchId, "Duel", 5120, 70, 1);

        const overall = await leaderboardSource("elo", 30, "Duel", "overall");
        const mm = await leaderboardSource("elo", 30, "Duel", "matchmaking");
        const tourney = await leaderboardSource("elo", 30, "Duel", "tournament");

        // `value` is the canonical latest rating: identical no matter which
        // Source is selected, because there is only one ELO stream.
        expect(Number(overall[0].value)).toBe(5120);
        expect(Number(mm[0].value)).toBe(5120);
        expect(Number(tourney[0].value)).toBe(5120);

        // League: no league-backed match exists for this player, so the
        // player is correctly dropped from the League view entirely (empty
        // state), while `value` for anyone who IS kept would still be
        // canonical.
        const league = await leaderboardSource("elo", 30, "Duel", "league");
        expect(league.find((r) => r.player_steam_id === player)).toBeUndefined();
      });

      it("scopes ELO secondary_value/matches_played to the selected source without touching value", async () => {
        const [player] = await fx.players(1);
        const mm1 = await fx.bareMatch(T(60 * 24 * 5));
        const mm2 = await fx.bareMatch(T(60 * 24 * 3));
        const tourneyMatch = await fx.bareMatch(T(60 * 24 * 1));
        await attachTournamentBracket(tourneyMatch.matchId);

        await insertElo(player, mm1.matchId, "Wingman", 5050, 50, 5);
        await insertElo(player, mm2.matchId, "Wingman", 5080, 30, 3);
        await insertElo(player, tourneyMatch.matchId, "Wingman", 5180, 100, 1);

        const overall = await leaderboardSource(
          "elo",
          30,
          "Wingman",
          "overall",
        );
        const mm = await leaderboardSource(
          "elo",
          30,
          "Wingman",
          "matchmaking",
        );
        const tourney = await leaderboardSource(
          "elo",
          30,
          "Wingman",
          "tournament",
        );

        // value: canonical, identical everywhere.
        for (const rows of [overall, mm, tourney]) {
          expect(Number(rows[0].value)).toBe(5180);
        }

        // secondary_value / matches_played: source-scoped contribution.
        expect(Number(overall[0].secondary_value)).toBe(180); // 50+30+100
        expect(Number(overall[0].matches_played)).toBe(3);
        expect(Number(mm[0].secondary_value)).toBe(80); // 50+30
        expect(Number(mm[0].matches_played)).toBe(2);
        expect(Number(tourney[0].secondary_value)).toBe(100);
        expect(Number(tourney[0].matches_played)).toBe(1);
      });

      it("scopes ELO Win Streak (tertiary_value) to the selected source -- regression for the bug where Tournament showed the Overall streak", async () => {
        // Real finished Duel matches, driving both the win_streak CTE
        // (which needs real matches/winning_lineup_id, not just player_elo
        // rows) and player_elo via generate_player_elo_for_match, exactly
        // like the ratedDuel helper above but with source attachment and
        // explicit end-dates so chronological order is deterministic.
        const ratedDuelSourced = async (
          a: string,
          b: string,
          { endedDaysAgo, tournament }: { endedDaysAgo: number; tournament: boolean },
        ) => {
          const match = await fx.match({ type: "Duel" });
          await fx.lineupPlayer(match.lineup_1_id, a);
          await fx.lineupPlayer(match.lineup_2_id, b);
          if (tournament) {
            await attachTournamentBracket(match.id);
          }
          // a always wins.
          await postgres.query(
            "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
            [match.id],
          );
          await postgres.query(
            "UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1",
            [match.id, endedDaysAgo],
          );
          await postgres.query("SELECT generate_player_elo_for_match($1)", [
            match.id,
          ]);
          return match;
        };

        const [a, b] = await fx.players(2);
        // Oldest first: 2 tournament wins, then 2 matchmaking wins -- a
        // wins all 4, so the unfiltered/Overall streak is 4, but the
        // Tournament-only streak (only among the 2 tournament matches) is 2,
        // and the Matchmaking-only streak is likewise 2.
        await ratedDuelSourced(a, b, { endedDaysAgo: 4, tournament: true });
        await ratedDuelSourced(a, b, { endedDaysAgo: 3, tournament: true });
        await ratedDuelSourced(a, b, { endedDaysAgo: 2, tournament: false });
        await ratedDuelSourced(a, b, { endedDaysAgo: 1, tournament: false });

        const overall = await leaderboardSource("elo", 30, "Duel", "overall");
        const tourney = await leaderboardSource(
          "elo",
          30,
          "Duel",
          "tournament",
        );
        const mm = await leaderboardSource(
          "elo",
          30,
          "Duel",
          "matchmaking",
        );

        const overallRow = overall.find((r) => r.player_steam_id === a)!;
        const tourneyRow = tourney.find((r) => r.player_steam_id === a)!;
        const mmRow = mm.find((r) => r.player_steam_id === a)!;

        expect(Number(overallRow.tertiary_value)).toBe(4);
        expect(Number(overallRow.matches_played)).toBe(4);

        expect(Number(tourneyRow.matches_played)).toBe(2);
        expect(Number(tourneyRow.tertiary_value)).toBe(2);

        expect(Number(mmRow.matches_played)).toBe(2);
        expect(Number(mmRow.tertiary_value)).toBe(2);

        // value stays canonical regardless of source, as always.
        expect(Number(tourneyRow.value)).toBe(Number(overallRow.value));
        expect(Number(mmRow.value)).toBe(Number(overallRow.value));
      });

      it("best_kdr buckets kills into Matchmaking vs Tournament, Overall combines both", async () => {
        const [player, victim] = await fx.players(2);
        const { ctx: mmCtx } = await statMatch([player, victim]);
        const { match: tourneyMatch, ctx: tourneyCtx } = await statMatch([
          player,
          victim,
        ]);
        await attachTournamentBracket(tourneyMatch.id);

        await fx.kill(mmCtx, player, victim);
        await fx.kill(mmCtx, player, victim, { round: 2 });
        await fx.kill(tourneyCtx, player, victim);

        const mm = await leaderboardSource(
          "best_kdr",
          30,
          "Competitive",
          "matchmaking",
        );
        const tourney = await leaderboardSource(
          "best_kdr",
          30,
          "Competitive",
          "tournament",
        );
        const overall = await leaderboardSource(
          "best_kdr",
          30,
          "Competitive",
          "overall",
        );

        expect(Number(mm[0].secondary_value)).toBe(2); // kills
        expect(Number(tourney[0].secondary_value)).toBe(1);
        expect(Number(overall[0].secondary_value)).toBe(3);
      });

      it("trophies + Matchmaking returns empty (trophies only ever belong to tournaments)", async () => {
        const tournament = await attachTournamentBracket(
          (await fx.bareMatch(T(1))).matchId,
        );
        const [player] = await fx.players(1);
        await postgres.query(
          `INSERT INTO tournament_trophies (tournament_id, player_steam_id, placement)
           VALUES ($1, $2, 1)`,
          [tournament.id, player],
        );

        const mm = await leaderboardSource(
          "trophies",
          0,
          null,
          "matchmaking",
        );
        expect(mm.length).toBe(0);

        const tourney = await leaderboardSource(
          "trophies",
          0,
          null,
          "tournament",
        );
        expect(tourney.length).toBe(1);
        expect(Number(tourney[0].value)).toBe(1); // gold count
      });

      it("League with no league-backed matches returns an empty leaderboard cleanly (non-ELO category)", async () => {
        const [a, b] = await fx.players(2);
        const { ctx } = await statMatch([a, b]);
        await fx.kill(ctx, a, b);

        const league = await leaderboardSource(
          "best_kdr",
          30,
          "Competitive",
          "league",
        );
        expect(league).toEqual([]);
      });

      it("classifies a league-backed tournament match distinctly from a standalone tournament match", async () => {
        const [player, victim] = await fx.players(2);
        const { match: leagueMatch, ctx: leagueCtx } = await statMatch([
          player,
          victim,
        ]);
        const leagueTournament = await attachTournamentBracket(
          leagueMatch.id,
          { league: true },
        );
        const { match: standaloneMatch, ctx: standaloneCtx } =
          await statMatch([player, victim]);
        await attachTournamentBracket(standaloneMatch.id);

        await fx.kill(leagueCtx, player, victim);
        await fx.kill(leagueCtx, player, victim, { round: 2 });
        await fx.kill(standaloneCtx, player, victim);

        try {
          const league = await leaderboardSource(
            "best_kdr",
            30,
            "Competitive",
            "league",
          );
          const tourney = await leaderboardSource(
            "best_kdr",
            30,
            "Competitive",
            "tournament",
          );

          expect(Number(league[0].secondary_value)).toBe(2);
          expect(Number(tourney[0].secondary_value)).toBe(1);
        } finally {
          // A league-linked tournament is guarded against direct
          // delete/cancel (hasura/triggers/tournaments.sql tbd_tournaments:
          // "This tournament belongs to a league..."), and the next test's
          // beforeEach does an unconditional `DELETE FROM tournaments`,
          // which would hit that guard and fail if this row is left
          // league-linked.
          //
          // Directly DELETEing the tournament ourselves (even with the
          // league_cascade bypass set) collides with tournament_brackets'
          // own delete-side trigger interactions ("tuple to be deleted was
          // already modified by an operation triggered by the current
          // command") -- the same class of trigger-ordering hazard already
          // documented around tournament deletion elsewhere in this
          // codebase. The sanctioned teardown is one level up: delete the
          // *league season* that owns this tournament. Its own
          // tbd_league_seasons BEFORE DELETE trigger (hasura/triggers/
          // league_seasons.sql) sets the same bypass and removes the
          // matches, then the tournament, in the correct order and on the
          // correct row versions -- exactly mirroring both production's
          // only sanctioned path for removing a league-owned tournament and
          // hasura/tests/leagues/cleanup.sql's own teardown convention.
          await postgres.query("DELETE FROM league_seasons WHERE id = $1", [
            leagueTournament.leagueSeasonId,
          ]);
        }
      });

      it("legacy callers that only pass _exclude_tournaments (no _source) still work and default to Overall", async () => {
        const [champ, rival] = await fx.players(2);
        await ratedDuel(champ, rival);
        await ratedDuel(champ, rival);
        await ratedDuel(rival, champ);

        // Old-style 4-arg positional call, exactly as pre-existing callers
        // (and the `leaderboard()` helper above) already use.
        const rows = await postgres.query<Array<LeaderboardRow>>(
          "SELECT * FROM get_leaderboard($1, $2, $3, $4)",
          ["best_win_rate", 30, "Duel", false],
        );
        expect(rows.map((r) => r.player_steam_id)).toEqual([champ, rival]);

        const [rank] = await postgres.query<
          Array<{ rank: number; total: number; value: number }>
        >(
          "SELECT * FROM get_player_leaderboard_rank('best_win_rate', 30, $1, 'Duel')",
          [rival],
        );
        expect(Number(rank.total)).toBe(2);
      });
    });
  });
});
