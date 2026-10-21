import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { PlayerOfTheMonthService } from "./../src/awards/player-of-the-month/player-of-the-month.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// Rollback safety for 1891100000100_player_of_the_month.
describe("Player of the Month migration (up/down)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const dir = join(__dirname, "../hasura/migrations/default/1891100000100_player_of_the_month");
  const up = readFileSync(join(dir, "up.sql"), "utf8");
  const down = readFileSync(join(dir, "down.sql"), "utf8");
  const exists = async (table: string) =>
    (await postgres.query<Array<{ t: string | null }>>(`SELECT to_regclass($1) AS t`, [`public.${table}`]))[0].t !== null;

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerOfTheMonthMigrationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199740000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("down removes everything while no award exists; up is re-runnable", async () => {
    await postgres.query(down);
    expect(await exists("player_of_the_month_reviews")).toBe(false);
    expect(await exists("player_of_the_month_review_events")).toBe(false);
    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM awards WHERE system_key = 'player_of_the_month'`,
    );
    expect(Number(count)).toBe(0);

    await postgres.query(up);
    await postgres.query(up); // idempotent
    expect(await exists("player_of_the_month_reviews")).toBe(true);
  });

  it("down refuses once a Player of the Month award exists", async () => {
    const admin = await fx.player();
    const [a, b] = await fx.players(2);
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    await postgres.query(`UPDATE matches SET status = 'Finished', winning_lineup_id = lineup_1_id WHERE id = $1`, [match.id]);
    await postgres.query(`UPDATE matches SET ended_at = '2026-08-10T12:00:00Z' WHERE id = $1`, [match.id]);

    const service = new PlayerOfTheMonthService(postgres);
    await service.calculate("2026-08", admin);
    await service.approve("2026-08", a, null, admin);

    await expect(postgres.query(down)).rejects.toThrow(/refusing to drop/);
    expect(await exists("player_of_the_month_reviews")).toBe(true);
  });
});
