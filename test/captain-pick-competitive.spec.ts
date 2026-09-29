import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

/**
 * 5v5 Captain Pick is only a different way of forming the teams. Once the
 * match exists it must be indistinguishable from Standard 5v5 matchmaking to
 * every ranking/stat system: same Competitive type, same ELO stream, same
 * season ladder, same leaderboard bucket, same no-show handling.
 *
 * Both helpers below write exactly what the API writes for each path
 * (createMatchBasedOnType's insert_matches_one: match_options + match on the
 * enabled Competitive pool, map veto on, then one insert per lineup, then
 * status Live). The only differences are the Captain Pick ones: a
 * pre-generated match id, drafted order with the captain first, and an
 * explicit captain flag.
 */
describe("Captain Pick matches are ordinary Competitive matchmaking (SQL)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let seasonId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("CaptainPickCompetitive");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await fx.enableSeasons(true);
    seasonId = await fx.season(
      new Date(Date.now() - 30 * 86400000).toISOString(),
    );
  });

  const competitivePoolId = async () => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM map_pools WHERE type = 'Competitive' AND enabled = true LIMIT 1`,
    );
    return pool.id;
  };

  const insertMatchmakingMatch = async ({
    id,
    lineup1,
    lineup2,
    captains,
  }: {
    id?: string;
    lineup1: Array<string>;
    lineup2: Array<string>;
    captains?: [string, string];
  }) => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options
         (type, mr, best_of, knife_round, overtime, timeout_setting,
          map_pool_id, map_veto, region_veto)
       VALUES ('Competitive', 12, 1, true, true, 'CoachAndPlayers',
               $1, true, false)
       RETURNING id`,
      [await competitivePoolId()],
    );

    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string; lineup_2_id: string }>
    >(
      id
        ? `INSERT INTO matches (id, match_options_id, region) VALUES ($2, $1, 'TestA') RETURNING *`
        : `INSERT INTO matches (match_options_id, region) VALUES ($1, 'TestA') RETURNING *`,
      id ? [options.id, id] : [options.id],
    );

    for (const [lineupId, steamIds] of [
      [match.lineup_1_id, lineup1],
      [match.lineup_2_id, lineup2],
    ] as const) {
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
         SELECT $1, unnest($2::bigint[])`,
        [lineupId, steamIds],
      );
    }

    if (captains) {
      for (const [lineupId, captain] of [
        [match.lineup_1_id, captains[0]],
        [match.lineup_2_id, captains[1]],
      ]) {
        await postgres.query(
          `UPDATE match_lineup_players SET captain = true
           WHERE match_lineup_id = $1 AND steam_id = $2`,
          [lineupId, captain],
        );
      }
    }

    await postgres.query(`UPDATE matches SET status = 'Live' WHERE id = $1`, [
      match.id,
    ]);

    return match;
  };

  const tenPlayers = async () => fx.players(10);

  const classification = async (matchId: string) => {
    const [row] = await postgres.query<Array<Record<string, unknown>>>(
      `SELECT mo.type,
              m.source,
              m.status,
              mo.map_veto,
              mp.type AS map_pool_type,
              mp.enabled AS map_pool_enabled,
              is_draft_match(m) AS is_draft_match,
              is_tournament_match(m) AS is_tournament_match,
              _leaderboard_match_source(m.id) AS leaderboard_source,
              (SELECT count(*)::int FROM draft_games dg WHERE dg.match_id = m.id) AS draft_games,
              (SELECT count(*)::int FROM team_scrim_requests s WHERE s.match_id = m.id) AS scrims
         FROM matches m
         JOIN match_options mo ON mo.id = m.match_options_id
         JOIN map_pools mp ON mp.id = mo.map_pool_id
        WHERE m.id = $1`,
      [matchId],
    );
    return row;
  };

  const finish = async (matchId: string, winner: 1 | 2) => {
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = lineup_${winner}_id WHERE id = $1`,
      [matchId],
    );
    await postgres.query(
      `UPDATE matches SET ended_at = now() - interval '1 hour' WHERE id = $1`,
      [matchId],
    );
  };

  const generateElo = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ generate_player_elo_for_match: number }>
    >("SELECT generate_player_elo_for_match($1)", [matchId]);
    return Number(row.generate_player_elo_for_match);
  };

  const captainPickId = "7c3a0c2e-6c1f-4d0e-9a3b-0f1e2d3c4b5a";

  it("has exactly the same classification as a Standard 5v5 match", async () => {
    const standardPlayers = await tenPlayers();
    const captainPlayers = await tenPlayers();

    const standard = await insertMatchmakingMatch({
      lineup1: standardPlayers.slice(0, 5),
      lineup2: standardPlayers.slice(5),
    });
    const captainPick = await insertMatchmakingMatch({
      id: captainPickId,
      lineup1: captainPlayers.slice(0, 5),
      lineup2: captainPlayers.slice(5),
      captains: [captainPlayers[0], captainPlayers[5]],
    });

    const expected = {
      type: "Competitive",
      source: "5stack",
      // Live without a map is the normal map veto.
      status: "Veto",
      map_veto: true,
      map_pool_type: "Competitive",
      map_pool_enabled: true,
      is_draft_match: false,
      is_tournament_match: false,
      leaderboard_source: "matchmaking",
      draft_games: 0,
      scrims: 0,
    };

    expect(await classification(standard.id)).toEqual(expected);
    expect(await classification(captainPick.id)).toEqual(expected);
  });

  it("keeps the drafted captains as the lineup captains", async () => {
    const players = await tenPlayers();
    // Drafted order puts the captain first; the explicit flag makes it hold
    // even if it weren't.
    const match = await insertMatchmakingMatch({
      id: captainPickId,
      lineup1: players.slice(0, 5),
      lineup2: players.slice(5),
      captains: [players[2], players[7]],
    });

    const captains = await postgres.query<
      Array<{ match_lineup_id: string; steam_id: string }>
    >(
      `SELECT match_lineup_id, steam_id::text FROM match_lineup_players
        WHERE match_lineup_id IN ($1, $2) AND captain = true
        ORDER BY match_lineup_id = $1 DESC`,
      [match.lineup_1_id, match.lineup_2_id],
    );

    expect(captains.map((c) => c.steam_id)).toEqual([players[2], players[7]]);
  });

  it("writes normal Competitive season ELO for every player", async () => {
    const players = await tenPlayers();
    const match = await insertMatchmakingMatch({
      id: captainPickId,
      lineup1: players.slice(0, 5),
      lineup2: players.slice(5),
      captains: [players[0], players[5]],
    });
    await finish(match.id, 1);

    expect(await generateElo(match.id)).toBe(10);

    const rows = await postgres.query<
      Array<{
        type: string;
        season_id: string | null;
        change: number;
        steam_id: string;
      }>
    >(
      `SELECT "type", season_id, change, steam_id::text FROM player_elo WHERE match_id = $1`,
      [match.id],
    );
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.type).toBe("Competitive");
      expect(row.season_id).toBe(seasonId);
      const won = players.slice(0, 5).includes(row.steam_id);
      expect(Math.sign(row.change)).toBe(won ? 1 : -1);
    }

    // The ratings players see are that same Competitive stream.
    const [rating] = await postgres.query<
      Array<{ lifetime: number; season: number; current: number }>
    >(
      `SELECT get_player_elo_by_type(p, 'Competitive')::int AS lifetime,
              get_player_season_elo_by_type(p, 'Competitive', $2)::int AS season,
              (SELECT current::int FROM player_elo WHERE match_id = $3 AND steam_id = p.steam_id) AS current
         FROM players p WHERE p.steam_id = $1`,
      [players[0], seasonId, match.id],
    );
    expect(rating.lifetime).toBe(rating.current);
    expect(rating.season).toBe(rating.current);

    // No other rating type was touched.
    const [{ others }] = await postgres.query<Array<{ others: number }>>(
      `SELECT count(*)::int AS others FROM player_elo WHERE match_id = $1 AND "type" <> 'Competitive'`,
      [match.id],
    );
    expect(others).toBe(0);
  });

  it("feeds the same Competitive matchmaking leaderboard and win/loss counts", async () => {
    const players = await tenPlayers();
    const match = await insertMatchmakingMatch({
      id: captainPickId,
      lineup1: players.slice(0, 5),
      lineup2: players.slice(5),
      captains: [players[0], players[5]],
    });
    await finish(match.id, 2);
    await generateElo(match.id);

    const board = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id FROM get_leaderboard('elo', 0, 'Competitive', false, NULL, $1, 'current', 'matchmaking')`,
      [seasonId],
    );
    expect(board.map((r) => r.player_steam_id).sort()).toEqual(
      [...players].sort(),
    );

    const [counts] = await postgres.query<
      Array<{ wins: number; losses: number }>
    >(
      `SELECT get_total_player_wins_by_type(p, 'Competitive') AS wins,
              get_total_player_losses_by_type(p, 'Competitive') AS losses
         FROM players p WHERE p.steam_id = $1`,
      [players[5]],
    );
    expect(counts).toEqual({ wins: 1, losses: 0 });
  });

  it("uses the normal no-show ELO penalty (no draft exception applies)", async () => {
    const players = await tenPlayers();
    const match = await insertMatchmakingMatch({
      id: captainPickId,
      lineup1: players.slice(0, 5),
      lineup2: players.slice(5),
      captains: [players[0], players[5]],
    });
    await postgres.query(
      `UPDATE matches SET status = 'Canceled' WHERE id = $1`,
      [match.id],
    );

    const [row] = await postgres.query<Array<{ change: number }>>(
      "SELECT apply_no_show_elo_penalty($1, $2) AS change",
      [match.id, players[3]],
    );
    expect(Number(row.change)).toBe(-250);

    const [elo] = await postgres.query<Array<{ type: string }>>(
      `SELECT "type" FROM player_elo WHERE match_id = $1 AND steam_id = $2`,
      [match.id, players[3]],
    );
    expect(elo.type).toBe("Competitive");
  });

  it("a canceled half-created match gives nobody ELO or a penalty", async () => {
    // What recovery leaves behind: match + options, no lineups seated, never
    // started, then canceled.
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (type, mr, best_of, map_pool_id, map_veto, region_veto)
       VALUES ('Competitive', 12, 1, $1, true, false) RETURNING id`,
      [await competitivePoolId()],
    );
    await postgres.query(
      `INSERT INTO matches (id, match_options_id, region) VALUES ($1, $2, 'TestA')`,
      [captainPickId, options.id],
    );
    await postgres.query(
      `UPDATE matches SET status = 'Canceled' WHERE id = $1`,
      [captainPickId],
    );

    const [match] = await postgres.query<
      Array<{
        status: string;
        cancels_at: Date | null;
        server_id: string | null;
      }>
    >(`SELECT status, cancels_at, server_id FROM matches WHERE id = $1`, [
      captainPickId,
    ]);
    expect(match.status).toBe("Canceled");
    expect(match.server_id).toBeNull();

    expect(await generateElo(captainPickId)).toBe(0);
    const [{ abandoned }] = await postgres.query<Array<{ abandoned: number }>>(
      `SELECT count(*)::int AS abandoned FROM abandoned_matches WHERE match_id = $1`,
      [captainPickId],
    );
    expect(abandoned).toBe(0);
  });

  it("adds no Captain Pick match type", async () => {
    const types = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM e_match_types ORDER BY value",
    );
    expect(types.map((t) => t.value)).toEqual([
      "Competitive",
      "Duel",
      "Faceit",
      "Premier",
      "Wingman",
    ]);
  });
});
