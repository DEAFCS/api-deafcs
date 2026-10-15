import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The same-tick case of upstream 5stackgg/api test/demo-import-kills.spec.ts
// (75b352a). The rest of that suite covers upstream SQL DEAFCS does not have
// (Rush imports, bomb deaths), so only this case is carried over.
describe("persist_imported_demo same-tick utility", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("DemoImportSameTickTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    await seedRegionWithServer(postgres, "TestDemoImportSameTick");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("keeps every grenade one player throws on the same tick", async () => {
    const ctx = await fx.bareMatch();
    const [demo] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_map_demos (match_id, match_map_id, file)
       VALUES ($1, $2, 'test.dem') RETURNING id`,
      [ctx.matchId, ctx.mapId],
    );
    const [thrower, victim] = await fx.players(2);

    const throwAt = (gid: number, type: string) => ({
      tick: 300,
      round: 1,
      gid,
      thrower,
      thrower_team: "ct",
      type,
    });

    await postgres.query(
      "SELECT public.persist_imported_demo($1::uuid, $2::jsonb)",
      [
        demo.id,
        JSON.stringify({
          map_name: "de_cache",
          tick_rate: 64,
          total_ticks: 2000,
          round_ticks: [{ round: 1, start_tick: 0, end_tick: 2000 }],
          players: [thrower, victim].map((steam_id) => ({
            steam_id,
            name: `p-${steam_id}`,
          })),
          grenade_throws: [
            throwAt(1, "HE"),
            throwAt(2, "HE"),
            throwAt(3, "Flash"),
          ],
          flashes: [1, 2].map(() => ({
            tick: 350,
            round: 1,
            attacker: thrower,
            victim,
            duration: 2,
          })),
        }),
      ],
    );

    const [utility] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM player_utility WHERE match_map_id = $1`,
      [ctx.mapId],
    );
    expect(Number(utility.count)).toBe(3);

    const [flashes] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM player_flashes WHERE match_map_id = $1`,
      [ctx.mapId],
    );
    expect(Number(flashes.count)).toBe(2);
  });
});
