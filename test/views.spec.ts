import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
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
      // Unplayed types stay null rather than defaulting.
      expect(profile.elo).toMatchObject({ competitive: null, wingman: null });
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
    const statMatch = async () => {
      const { poolId } = await fx.mapPool(1);
      const match = await fx.match({ mapPoolId: poolId });
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
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
        expect(Number(peak[0].secondary_value)).toBe(0);

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

      it("includes tournament changes in the rolling sum when Exclude Tournaments is off, and excludes them when on", async () => {
        // A single-elimination stage needs at least 4 teams (see
        // TournamentFixtures.createTournament's stage validation, exercised
        // the same way in elo.spec.ts's tournament test) — 2 teams isn't a
        // valid bracket size and the tournament never reaches Live.
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
        expect(Number(excludedRow.secondary_value)).toBe(50);
        // Tournament rows carry no season_id, so the current-value baseline
        // in the exclude branch is also tournament-adjusted; only the
        // rolling-sum column is under test here.
        expect(Number(excludedRow.value)).toBe(5050);
      });

      it("leaves named-season ELO Change on the existing final-minus-starting formula", async () => {
        const [player] = await fx.players(1);
        const seasonId = await fx.season("2021-01-01", null);
        const first = await fx.bareMatch(T(60 * 24 * 3));
        const second = await fx.bareMatch(T(60 * 24 * 1));

        await insertElo(player, first.matchId, "Competitive", 5200, 200, 3, seasonId);
        await insertElo(
          player,
          second.matchId,
          "Competitive",
          5150,
          -50,
          1,
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

      it("leaves Peak's secondary_value at zero", async () => {
        const [player] = await fx.players(1);
        const match = await fx.bareMatch(T(60 * 24 * 2));
        await insertElo(player, match.matchId, "Duel", 5300, 300, 2);

        const [row] = await eloLeaderboard(0, "Duel", "peak");
        expect(Number(row.value)).toBe(5300);
        expect(Number(row.secondary_value)).toBe(0);
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

    // Named seasons only ever included player_elo rows with season_id equal
    // to the season's UUID. Tournament matches always write season_id = NULL
    // (season-independent by design), so a tournament played during a named
    // season was invisible to that season's ELO/rank/matches/win streak.
    // These tests cover the fix, scoped to an ACTIVE named season only --
    // a completed season keeps its old final-minus-starting secondary_value
    // and regular-only value untouched (also covered below).
    describe("active-season tournament ELO", () => {
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

      // A single-elimination stage needs >= 4 teams (see TournamentFixtures.
      // createTournament's stage validation; same pattern used throughout
      // elo.spec.ts and the rolling-window tournament test above).
      const launchTournament = (type: "Competitive" | "Wingman" | "Duel" = "Wingman") =>
        tournamentFx.launch(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
          4,
          type,
        );

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

      it("1. includes regular season matches for an active season", async () => {
        const seasonId = await fx.season("2020-01-01", null); // open-ended => active
        const [player] = await fx.players(1);
        const m1 = await fx.bareMatch();
        const m2 = await fx.bareMatch();
        await insertElo(player, m1.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, m2.matchId, "Wingman", 5250, 150, 1, seasonId);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5250);
        expect(Number(row.secondary_value)).toBe(150); // Last Match
        expect(Number(row.matches_played)).toBe(2);
      });

      it("2. includes an eligible tournament match played inside the active season's dates", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        // Tournament row: season_id NULL, global current (5900) must NOT be
        // used as the season's ELO.
        await insertElo(player, bracket.match_id!, "Wingman", 5900, 250, 1);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5350); // 5100 (regular current) + 250 (tourney sum)
        expect(Number(row.secondary_value)).toBe(250); // Last Match: tournament is the latest row
        expect(Number(row.matches_played)).toBe(2);
      });

      it("3. excludes a tournament match that finished before the season started", async () => {
        const seasonStart = new Date(
          Date.now() - 5 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const seasonId = await fx.season(seasonStart, null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 2, seasonId);
        const beforeSeason = new Date(
          Date.now() - 10 * 24 * 60 * 60 * 1000,
        ).toISOString();
        await insertEloAt(player, bracket.match_id!, "Wingman", 9999, 500, beforeSeason);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.secondary_value)).toBe(100);
        expect(Number(row.matches_played)).toBe(1);
      });

      it("4. excludes a tournament match at or after the season's end boundary", async () => {
        const now = Date.now();
        const start = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
        const end = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(); // future => still active
        const seasonId = await fx.season(start, end);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 5, seasonId);
        // Exactly at the end boundary: [_from, _to) is half-open, so this
        // must be excluded.
        await insertEloAt(player, bracket.match_id!, "Wingman", 9999, 500, end);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.matches_played)).toBe(1);
      });

      it("5. a tournament bracket match with no player_elo row contributes nothing", async () => {
        // There is no elo-enabled/ranked/rated setting anywhere in the
        // schema for tournaments or tournament_stages (verified by a full
        // migration-history audit), and generate_player_elo_for_match has no
        // tournament-specific skip condition -- a tournament player_elo row
        // existing is unconditional proof ELO ran for that match, the same
        // as any other match. So there is nothing to "disable": eligibility
        // here only ever reads EXISTING player_elo rows, and a bracket match
        // that simply has no row (e.g. because it hasn't been played, or
        // because the row was never generated for any of the ordinary
        // generic reasons -- no winner, non-5stack source) contributes
        // nothing, without any extra predicate needed.
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const brackets = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).filter((b) => b.round === 1);
        const [withRow, withoutRow] = brackets;
        expect(withoutRow.match_id).not.toBeNull();

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, withRow.match_id!, "Wingman", 5300, 200, 1);
        // Deliberately no insertElo call for withoutRow.match_id.

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5300); // 5100 + 200; withoutRow contributes 0
        expect(Number(row.matches_played)).toBe(2);
      });

      it("6. excludes an unfinished tournament match (no player_elo row exists for it either)", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const brackets = await tournamentFx.getBrackets(tournament.stageIds[0]);
        // The final (round 2) hasn't been played -- scheduled, not finished,
        // no winner -- so generate_player_elo_for_match would never produce
        // a row for it (winning_lineup_id IS NULL guard). No row is inserted
        // for it here either.
        const unfinished = brackets.find((b) => b.round === 2);
        expect(unfinished).toBeDefined();

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.matches_played)).toBe(1);
      });

      it("7. Exclude Tournaments off includes the tournament change", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 5900, 250, 1);

        const [row] = await seasonElo(seasonId, "Wingman", false);
        expect(Number(row.value)).toBe(5350);
      });

      it("8. Exclude Tournaments on excludes the tournament change", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 5900, 250, 1);

        const [row] = await seasonElo(seasonId, "Wingman", true);
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.secondary_value)).toBe(100); // Last Match: regular-only
        expect(Number(row.matches_played)).toBe(1);
      });

      it("9. rank changes consistently when tournament ELO is included", async () => {
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
        // Leader's tournament win pushes them above chaser only when
        // tournaments are included.
        await insertElo(leader, bracket.match_id!, "Wingman", 9999, 100, 1);

        const [includedRank] = await postgres.query<
          Array<{ rank: number }>
        >(
          `SELECT * FROM get_player_leaderboard_rank('elo', 0, $1, 'Wingman', false, $2, 'current')`,
          [leader, seasonId],
        );
        const [excludedRank] = await postgres.query<
          Array<{ rank: number }>
        >(
          `SELECT * FROM get_player_leaderboard_rank('elo', 0, $1, 'Wingman', true, $2, 'current')`,
          [leader, seasonId],
        );
        expect(Number(includedRank.rank)).toBe(1);
        expect(Number(excludedRank.rank)).toBe(2);
      });

      it("10. matches_played follows the Exclude Tournaments toggle", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 5900, 250, 1);

        const [includedRow] = await seasonElo(seasonId, "Wingman", false);
        const [excludedRow] = await seasonElo(seasonId, "Wingman", true);
        expect(Number(includedRow.matches_played)).toBe(2);
        expect(Number(excludedRow.matches_played)).toBe(1);
      });

      it("11. win streak follows the Exclude Tournaments toggle", async () => {
        // win_streak was audited and needed no SQL change: it computes from
        // matches directly (there is no season_id column on matches), and
        // already respects both the season's date window and the
        // Exclude Tournaments toggle (via a tournament_brackets NOT EXISTS
        // clause present only in that branch). This test confirms that
        // pre-existing behavior still holds for an active season.
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;
        await tournamentFx.winMatch(bracket.match_id!);
        await postgres.query(
          "UPDATE matches SET status = 'Finished' WHERE id = $1",
          [bracket.match_id],
        );
        const [winner] = await postgres.query<Array<{ steam_id: string }>>(
          `SELECT mlp.steam_id
             FROM matches m
             JOIN match_lineup_players mlp ON mlp.match_lineup_id = m.winning_lineup_id
            WHERE m.id = $1
            LIMIT 1`,
          [bracket.match_id],
        );

        const [loser] = await fx.players(1);
        const regularWin = await finishedMatch(
          "Wingman",
          winner.steam_id,
          loser,
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        );
        await insertElo(winner.steam_id, regularWin.id, "Wingman", 5200, 100, 1, seasonId);
        await insertElo(winner.steam_id, bracket.match_id!, "Wingman", 9999, 100, 2);

        const [includedRow] = await seasonElo(seasonId, "Wingman", false);
        const [excludedRow] = await seasonElo(seasonId, "Wingman", true);
        expect(Number(includedRow.tertiary_value)).toBe(2); // tournament win + regular win
        expect(Number(excludedRow.tertiary_value)).toBe(1); // regular win only
      });

      it("12. Last Match off may return the latest tournament delta", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 9999, 275, 1);

        const [row] = await seasonElo(seasonId, "Wingman", false);
        expect(Number(row.secondary_value)).toBe(275);
      });

      it("13. Last Match on returns the latest regular delta even if a tournament match is more recent", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        await insertElo(player, bracket.match_id!, "Wingman", 9999, 275, 1); // more recent than regular

        const [row] = await seasonElo(seasonId, "Wingman", true);
        expect(Number(row.secondary_value)).toBe(100);
      });

      it("14. leaves a completed season's ELO Change on the final-minus-starting formula, tournaments ignored either way", async () => {
        const start = new Date(
          Date.now() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const end = new Date(
          Date.now() - 1 * 24 * 60 * 60 * 1000,
        ).toISOString(); // in the past => completed, not active
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
        // Inside the season's [start, end) window, but must still be ignored:
        // this season is completed, not active.
        const insideWindow = new Date(
          Date.now() - 15 * 24 * 60 * 60 * 1000,
        ).toISOString();
        await insertEloAt(player, bracket.match_id!, "Wingman", 9999, 900, insideWindow);

        const [row] = await seasonElo(seasonId);
        // Final (5150) minus starting-of-season (5200 - 200 = 5000) = 150.
        expect(Number(row.value)).toBe(5150);
        expect(Number(row.secondary_value)).toBe(150);
      });

      it("15. leaves rolling 7/30-day SUM(change) unaffected", async () => {
        const [player] = await fx.players(1);
        const m1 = await fx.bareMatch(T(60 * 24 * 5));
        const m2 = await fx.bareMatch(T(60 * 24 * 1));
        await insertElo(player, m1.matchId, "Wingman", 5100, 100, 5);
        await insertElo(player, m2.matchId, "Wingman", 5160, 60, 1);

        const [row] = await eloLeaderboard(7, "Wingman");
        expect(Number(row.secondary_value)).toBe(160);
      });

      it("16. leaves Peak unaffected", async () => {
        const [player] = await fx.players(1);
        const match = await fx.bareMatch();
        await insertElo(player, match.matchId, "Wingman", 5400, 400, 2);

        const [row] = await eloLeaderboard(0, "Wingman", "peak");
        expect(Number(row.value)).toBe(5400);
        expect(Number(row.secondary_value)).toBe(0);
      });

      it("17. keeps tournament eligibility isolated per match type", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Duel");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        // A Duel tournament change must not leak into the Wingman season row.
        await insertElo(player, bracket.match_id!, "Duel", 9999, 500, 1);

        const [row] = await seasonElo(seasonId, "Wingman");
        expect(Number(row.value)).toBe(5100);
        expect(Number(row.matches_played)).toBe(1);
      });

      it("18. does not double-count across several regular and tournament matches", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const brackets = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).filter((b) => b.round === 1);

        const [player] = await fx.players(1);
        const regularA = await fx.bareMatch();
        const regularB = await fx.bareMatch();
        await insertElo(player, regularA.matchId, "Wingman", 5100, 100, 5, seasonId);
        await insertElo(player, regularB.matchId, "Wingman", 5060, -40, 4, seasonId);
        await insertElo(player, brackets[0].match_id!, "Wingman", 9999, 80, 3);
        await insertElo(player, brackets[1].match_id!, "Wingman", 9999, 30, 2);

        const [row] = await seasonElo(seasonId);
        // 5060 (regular current) + 80 + 30 = 5170; four rows, not eight.
        expect(Number(row.value)).toBe(5170);
        expect(Number(row.matches_played)).toBe(4);
      });

      it("19. surfaces a player whose only activity this season was a tournament match, anchored at the 5000 baseline", async () => {
        const seasonId = await fx.season("2020-01-01", null);
        const tournament = await launchTournament("Wingman");
        const bracket = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).find((b) => b.round === 1)!;

        const [player] = await fx.players(1);
        await insertElo(player, bracket.match_id!, "Wingman", 9999, 300, 1);

        const [row] = await seasonElo(seasonId);
        expect(row).toBeDefined();
        expect(Number(row.value)).toBe(5300); // 5000 baseline + 300
        expect(Number(row.secondary_value)).toBe(300);
        expect(Number(row.matches_played)).toBe(1);

        // Under Exclude Tournaments, this player has no regular-season row
        // at all, so they don't appear.
        const excludedRows = await seasonElo(seasonId, "Wingman", true);
        expect(
          excludedRows.find((r) => r.player_steam_id === player),
        ).toBeUndefined();
      });

      it("20. respects exact timestamp boundaries: inclusive start, exclusive end", async () => {
        const start = new Date(
          Date.now() - 6 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const end = new Date(
          Date.now() + 1 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const seasonId = await fx.season(start, end);
        const tournament = await launchTournament("Wingman");
        const brackets = (
          await tournamentFx.getBrackets(tournament.stageIds[0])
        ).filter((b) => b.round === 1);

        const [player] = await fx.players(1);
        const regularMatch = await fx.bareMatch();
        await insertElo(player, regularMatch.matchId, "Wingman", 5100, 100, 3, seasonId);
        // Exactly at start: >= is inclusive, must count.
        await insertEloAt(player, brackets[0].match_id!, "Wingman", 9999, 50, start);
        // Exactly at end: < is exclusive, must not count.
        await insertEloAt(player, brackets[1].match_id!, "Wingman", 9999, 999, end);

        const [row] = await seasonElo(seasonId);
        expect(Number(row.value)).toBe(5250); // 5100 + 50, not +999
        expect(Number(row.matches_played)).toBe(2);
      });
    });

    it("defaults omitted ELO view to current and validates unsupported views", async () => {
      const [player] = await fx.players(1);
      const match = await fx.bareMatch(T(60));
      await insertElo(player, match.matchId, "Duel", 5400, 75, 0);

      const omitted = await leaderboard("elo", 0, "Duel");
      expect(Number(omitted[0].value)).toBe(5400);
      expect(Number(omitted[0].secondary_value)).toBe(75);

      await expect(
        postgres.query(
          "SELECT * FROM get_leaderboard('elo', 0, 'Duel', false, NULL, NULL, 'invalid')",
        ),
      ).rejects.toThrow(/Invalid ELO view/);
      await expect(
        postgres.query(
          "SELECT * FROM get_leaderboard('elo', 7, 'Duel', false, NULL, NULL, 'peak')",
        ),
      ).rejects.toThrow(/Peak ELO view only supports/);
    });

    it("preserves season-current behavior and rejects a season peak view", async () => {
      const [player] = await fx.players(1);
      const seasonId = await fx.season("2025-01-01");
      const firstMatch = await fx.bareMatch(T(60 * 24 * 2));
      const latestMatch = await fx.bareMatch(T(60 * 24));
      await insertElo(
        player,
        firstMatch.matchId,
        "Competitive",
        5100,
        100,
        2,
        seasonId,
      );
      await insertElo(
        player,
        latestMatch.matchId,
        "Competitive",
        5075,
        -25,
        1,
        seasonId,
      );

      const [current] = await postgres.query<Array<LeaderboardRow>>(
        `SELECT * FROM get_leaderboard(
           'elo', 0, 'Competitive', false, NULL, $1, 'current'
         )`,
        [seasonId],
      );
      expect(Number(current.value)).toBe(5075);
      expect(Number(current.secondary_value)).toBe(75);

      await expect(
        postgres.query(
          `SELECT * FROM get_leaderboard(
             'elo', 0, 'Competitive', false, NULL, $1, 'peak'
           )`,
          [seasonId],
        ),
      ).rejects.toThrow(/Peak ELO view only supports/);
    });

    it("keeps rank ties and total population behavior unchanged", async () => {
      const [one, two] = await fx.players(2);
      const match = await fx.bareMatch(T(60));
      await insertElo(one, match.matchId, "Wingman", 5600, 50, 0);
      await insertElo(two, match.matchId, "Wingman", 5600, -20, 0);

      for (const player of [one, two]) {
        const [rank] = await postgres.query<
          Array<{ rank: number; total: number }>
        >(
          `SELECT * FROM get_player_leaderboard_rank(
             'elo', 0, $1, 'Wingman', false, NULL, 'current'
           )`,
          [player],
        );
        expect(Number(rank.rank)).toBe(1);
        expect(Number(rank.total)).toBe(2);
      }
    });

    it("uses match_id as a deterministic tie-breaker for equal ledger timestamps", async () => {
      const [player] = await fx.players(1);
      const firstMatch = await fx.bareMatch(T(60));
      const secondMatch = await fx.bareMatch(T(60));
      const createdAt = T(30);
      const rows = [
        { matchId: firstMatch.matchId, current: 5500, change: 100 },
        { matchId: secondMatch.matchId, current: 5650, change: 150 },
      ].sort((a, b) => b.matchId.localeCompare(a.matchId));

      for (const row of rows) {
        await postgres.query(
          `INSERT INTO player_elo
             (steam_id, match_id, type, "current", change, created_at)
           VALUES ($1, $2, 'Duel', $3, $4, $5)`,
          [player, row.matchId, row.current, row.change, createdAt],
        );
      }

      const [current] = await eloLeaderboard(0, "Duel");
      expect(Number(current.value)).toBe(rows[0].current);
      expect(Number(current.secondary_value)).toBe(rows[0].change);
    });

    it("preserves tournament inclusion and exclusion adjustments", async () => {
      const tournament = await tournamentFx.launch(
        [
          {
            type: "SingleElimination",
            order: 1,
            minTeams: 2,
            maxTeams: 2,
          },
        ],
        2,
      );
      const [bracket] = await tournamentFx.getBrackets(tournament.stageIds[0]);
      expect(bracket.match_id).not.toBeNull();

      const [player] = await fx.players(1);
      const regularMatch = await fx.bareMatch(T(60 * 24 * 2));
      await insertElo(player, regularMatch.matchId, "Wingman", 5000, 0, 2);
      await insertElo(player, bracket.match_id!, "Wingman", 5100, 100, 1);

      const [includedCurrent] = await eloLeaderboard(
        0,
        "Wingman",
        "current",
        false,
      );
      const [excludedCurrent] = await eloLeaderboard(
        0,
        "Wingman",
        "current",
        true,
      );
      const [excludedPeak] = await eloLeaderboard(0, "Wingman", "peak", true);

      expect(Number(includedCurrent.value)).toBe(5100);
      expect(Number(includedCurrent.secondary_value)).toBe(100);
      expect(Number(excludedCurrent.value)).toBe(5000);
      expect(Number(excludedPeak.value)).toBe(5000);
      expect(Number(excludedPeak.secondary_value)).toBe(0);
    });

    it("best_kdr divides kills by deaths, falling back to kill count for the deathless", async () => {
      const { ctx } = await statMatch();
      const [ace, feeder, cleaner, target] = await fx.players(4);
      for (const round of [1, 2, 3]) {
        await fx.kill(ctx, ace, feeder, { round });
      }
      await fx.kill(ctx, feeder, ace);
      await fx.kill(ctx, cleaner, target);
      await fx.kill(ctx, cleaner, target, { round: 2 });

      const rows = await leaderboard("best_kdr", 30, "Competitive");
      // ace 3/1, cleaner deathless (value = raw kill count 2), feeder 1/3.
      expect(rows.map((r) => r.player_steam_id)).toEqual([
        ace,
        cleaner,
        feeder,
      ]);
      const byId = new Map(rows.map((r) => [r.player_steam_id, r]));
      expect(Number(byId.get(ace)!.value)).toBe(3);
      expect(Number(byId.get(ace)!.secondary_value)).toBe(3); // kills
      expect(Number(byId.get(ace)!.tertiary_value)).toBe(1); // deaths
      expect(Number(byId.get(cleaner)!.value)).toBe(2);
      expect(Number(byId.get(cleaner)!.tertiary_value)).toBe(0);
      expect(Number(byId.get(feeder)!.value)).toBeCloseTo(0.33, 2);
      // Never got a kill: not on the board, despite the deaths.
      expect(byId.has(target)).toBe(false);
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

    it("highest_hs_pct ranks headshot ratios from the kill feed", async () => {
      const { ctx } = await statMatch();
      const [surgeon, sprayer, victim] = await fx.players(3);
      await fx.kill(ctx, surgeon, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: true });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 2 });
      await fx.kill(ctx, sprayer, victim, { headshot: false, round: 3 });

      const rows = await leaderboard("highest_hs_pct", 30, "Competitive");
      expect(rows.map((r) => r.player_steam_id)).toEqual([surgeon, sprayer]);
      expect(Number(rows[0].value)).toBe(100);
      expect(Number(rows[0].secondary_value)).toBe(1); // total kills
      expect(Number(rows[1].value)).toBeCloseTo(33.33, 2);
      expect(Number(rows[1].secondary_value)).toBe(3);
    });

    it("stat categories respect the day window, with 0 meaning all time", async () => {
      const { ctx } = await statMatch();
      const [a, b] = await fx.players(2);
      await fx.kill(ctx, a, b, { time: T(60 * 24 * 40) }); // 40 days back

      expect((await leaderboard("best_kdr", 30, "Competitive")).length).toBe(0);
      expect((await leaderboard("best_kdr", 0, "Competitive")).length).toBe(1);
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
  });
});
