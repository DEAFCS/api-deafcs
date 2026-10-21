import { PostgresService } from "./../src/postgres/postgres.service";
import { WeeklyRecordsService } from "./../src/stats/weekly-records.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// GET /stats/weekly-records against the real schema: the SQL reads the same
// views the homepage reads through Hasura (v_player_match_rating,
// player_match_stats_v, v_match_clutches, v_match_player_opening_duels) and
// applies the same window/type/status/source filters.
describe("weekly records (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: WeeklyRecordsService;

  const noCache = {
    get: async () => undefined,
    put: async () => true,
    acquireLock: async () => "token",
    releaseLock: async () => true,
  };

  beforeAll(async () => {
    db = await bootMigratedDb("WeeklyRecordsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    await seedRegionWithServer(postgres, "TestA");
    service = new WeeklyRecordsService(postgres, noCache as any, { warn: jest.fn() } as any);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const T = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  // A finished 1v1-seated match of the given type with two rounds: `a` takes
  // the opening kill and a clutch-shaped round 1, `b` the opening of round 2.
  async function finishedMatch(type: string, endedMinutesAgo: number, a: string, b: string) {
    const match = await fx.match({ type, mapVeto: true });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    const ctx = { matchId: match.id, mapId: map.id };
    await fx.kill(ctx, a, b, { round: 1, time: T(endedMinutesAgo + 20), attackerTeam: "CT", victimTeam: "TERRORIST", headshot: true });
    await fx.damage(ctx, a, b, 100, { round: 1, attackerTeam: "CT", victimTeam: "TERRORIST" });
    await fx.kill(ctx, b, a, { round: 2, time: T(endedMinutesAgo + 10), attackerTeam: "TERRORIST", victimTeam: "CT" });
    await fx.round(map.id, 1, { winningSide: "CT", time: T(endedMinutesAgo + 19) });
    await fx.round(map.id, 2, { l1Score: 1, l2Score: 1, winningSide: "TERRORIST", time: T(endedMinutesAgo + 9) });
    await postgres.query(
      `UPDATE matches SET status = 'Finished', winning_lineup_id = lineup_1_id WHERE id = $1`,
      [match.id],
    );
    // The finish trigger stamps ended_at = now(); back-date it afterwards.
    await postgres.query(`UPDATE matches SET ended_at = $2 WHERE id = $1`, [
      match.id,
      T(endedMinutesAgo),
    ]);
    return match.id;
  }

  it("reads the real views with the homepage's filters", async () => {
    const [a, b] = await fx.players(2);
    const counted = await finishedMatch("Competitive", 60, a, b);
    // Outside the rules: a Duel this week, and a Competitive match 8 days ago.
    await finishedMatch("Duel", 60, a, b);
    await finishedMatch("Competitive", 8 * 24 * 60, a, b);

    const result = await service.compute("Competitive");
    expect(result.matchCount).toBe(1);

    const record = (key: string) => result.records.find((r) => r.key === key);
    expect(record("kills")?.entries.map((e) => [e.steamId, e.value])).toEqual([
      [a, 1],
      [b, 1],
    ]);
    expect(record("opening_kills")?.entries.map((e) => [e.steamId, e.value])).toEqual([
      [a, 1],
      [b, 1],
    ]);
    expect(record("matches")?.entries[0].value).toBe(1);
    // Two rounds only: no rate or single-match record qualifies.
    expect(record("rating")).toBeUndefined();
    expect(record("match_kills")).toBeUndefined();
    // Clutches are only read for true 5v5 lineups (this one is 1v1 seated).
    expect(record("clutches")).toBeUndefined();

    expect(result.players[a]).toEqual(expect.objectContaining({ name: expect.any(String) }));
    expect(counted).toEqual(expect.any(String));
  });

  it("no finished Competitive match in the window: empty, no errors", async () => {
    const result = await service.compute("Competitive");
    expect(result).toMatchObject({ matchCount: 0, records: [], players: {} });
  });
});
