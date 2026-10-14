import { Pool } from "pg";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";

// Synthetic data only. No API .env, production credentials or production
// message content. A unique database is created, never an existing DB replaced.
const dbDescribe =
  process.env.MESSAGE_REQUESTS_TEST_PORT === "15437" ? describe : describe.skip;
const migrationPath = join(
  __dirname,
  "../../hasura/migrations/default/1890000000900_direct_message_requests",
);
const migration = readFileSync(join(migrationPath, "up.sql"), "utf8");
const down = readFileSync(join(migrationPath, "down.sql"), "utf8");
const optimized = migration.slice(
  migration.indexOf("WITH legacy_rooms AS MATERIALIZED"),
);
// Preserve the previous query as a benchmark/equivalence oracle. It is never
// used by production and runs only against this disposable synthetic database.
const original = `INSERT INTO public.direct_conversations(room_id,steam_id,last_message_at,accepted_at)
 SELECT substring(n.entity_id from 8), p.steam_id, max(n.created_at), max(n.created_at)
 FROM public.notifications n JOIN public.players p ON p.steam_id::text IN
 (split_part(substring(n.entity_id from 8),':',1),split_part(substring(n.entity_id from 8),':',2))
 WHERE n.type::text='ChatMessage'
 AND CASE WHEN n.entity_id ~ '^direct:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$' THEN
   split_part(substring(n.entity_id from 8),':',1)::numeric < split_part(substring(n.entity_id from 8),':',2)::numeric
   AND split_part(substring(n.entity_id from 8),':',2)::numeric <= 9223372036854775807
   AND EXISTS(SELECT 1 FROM public.players peer WHERE peer.steam_id::text = CASE WHEN p.steam_id::text = split_part(substring(n.entity_id from 8),':',1) THEN split_part(substring(n.entity_id from 8),':',2) ELSE split_part(substring(n.entity_id from 8),':',1) END)
 ELSE false END
 GROUP BY n.entity_id,p.steam_id ON CONFLICT(room_id,steam_id) DO NOTHING;`;
const base = 76561198000000000n;
const sid = (n: number) => String(base + BigInt(n));
const malformed = [
  `direct:${sid(1)}:${sid(2)}:3`,
  `direct:${sid(2)}:${sid(1)}`,
  `direct:${sid(1)}:${sid(1)}`,
  `direct:0:${sid(1)}`,
  `direct:0${sid(1)}:${sid(2)}`,
  `direct:-1:${sid(2)}`,
  `direct:1e2:${sid(2)}`,
  `direct: 1:${sid(2)}`,
  `direct:1:9223372036854775808`,
  `direct:9223372036854775808:9223372036854775809`,
  `direct:1:99999999999999999999`,
  `direct:${sid(1)}:${sid(4000)}`,
  `direct:${sid(4000)}:${sid(4001)}`,
  null,
];
const stable = (rows: any[]) =>
  rows.map((r) => ({
    ...r,
    last_message_at: r.last_message_at.toISOString(),
    accepted_at: r.accepted_at?.toISOString() ?? null,
  }));

dbDescribe(
  "legacy direct backfill on production-sized synthetic PostgreSQL",
  () => {
    let pool: Pool;
    let report: Record<string, any> = {};
    const rows = async () =>
      stable(
        (
          await pool.query(
            "SELECT room_id,steam_id::text,last_message_at,accepted_at FROM direct_conversations ORDER BY room_id,steam_id",
          )
        ).rows,
      );
    const fingerprint = async () =>
      (
        await pool.query(`SELECT
    (SELECT md5(string_agg(row_to_json(n)::text,'' ORDER BY id)) FROM notifications n) AS notifications,
    (SELECT md5(string_agg(row_to_json(b)::text,'' ORDER BY blocker_steam_id,blocked_steam_id)) FROM player_blocks b) AS blocks,
    (SELECT md5(string_agg(row_to_json(f)::text,'' ORDER BY player_steam_id,other_player_steam_id)) FROM friends f) AS friends`)
      ).rows[0];
    beforeAll(async () => {
      const database = "deafcs_requests_backfill_qa_" + Date.now();
      if (!/^deafcs_requests_backfill_qa_[0-9]+$/.test(database))
        throw Error("invalid scratch database");
      const connection = { host: "127.0.0.1", port: 15437, user: "postgres" };
      const admin = new Pool({ ...connection, database: "postgres" });
      try {
        await admin.query('CREATE DATABASE "' + database + '"');
      } finally {
        await admin.end();
      }
      pool = new Pool({ ...connection, database });
      await pool.query(`CREATE TABLE players(steam_id bigint PRIMARY KEY,name text);
      CREATE TABLE friends(player_steam_id bigint,other_player_steam_id bigint,status text);
      CREATE TABLE player_blocks(blocker_steam_id bigint,blocked_steam_id bigint);
      CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),type text,entity_id text,created_at timestamptz NOT NULL);
      INSERT INTO players SELECT ${base} + n,'Synthetic player' FROM generate_series(1,3509) n;
      INSERT INTO players VALUES(1,'Boundary'),(9223372036854775807,'Boundary');
      INSERT INTO friends VALUES(${sid(1)},${sid(2)},'Accepted');
      INSERT INTO player_blocks VALUES(${sid(7)},${sid(8)});
      INSERT INTO notifications(type,entity_id,created_at)
        SELECT 'ChatMessage',CASE WHEN n<=2560 THEN 'direct:'||(${base}+2*(n%128)+1)||':'||(${base}+2*(n%128)+2) ELSE 'match:synthetic-'||(n%1000) END,
        '2026-10-01 00:00:00+00'::timestamptz + n*interval '1 second'
        FROM generate_series(1,61000) n;
      INSERT INTO notifications(type,entity_id,created_at) VALUES('ChatMessage','direct:1:9223372036854775807','2026-10-01'),('Other','direct:${sid(1)}:${sid(3509)}','2026-10-01');`);
      for (const entity of malformed)
        await pool.query(
          "INSERT INTO notifications(type,entity_id,created_at) VALUES('ChatMessage',$1,'2026-10-01')",
          [entity],
        );
      await pool.query("ANALYZE players; ANALYZE notifications");
      const before = await fingerprint();
      const started = performance.now();
      await pool.query("BEGIN; SET LOCAL statement_timeout='15s'");
      try {
        await pool.query(migration);
        // ALTER TABLE's lock lasts until COMMIT, even though the backfill is fast.
        const locks = (
          await pool.query(
            "SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation='players'::regclass",
          )
        ).rows;
        report.playersLockModes = locks.map((r) => r.mode);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
      report.fullMigrationMs = performance.now() - started;
      report.fixture = {
        players: 3511,
        notifications: 61016,
        directNotifications: 2561,
      };
      expect(await fingerprint()).toEqual(before);
    }, 30000);
    afterAll(async () => {
      if (process.env.MESSAGE_REQUESTS_BENCHMARK_REPORT)
        writeFileSync(
          process.env.MESSAGE_REQUESTS_BENCHMARK_REPORT,
          JSON.stringify(report, null, 2),
        );
      await pool?.end();
    });
    it("imports exactly two existing participants per valid room with latest timestamps", async () => {
      const actual = await rows();
      expect(actual).toHaveLength(258);
      const expected = new Map<string, string>();
      for (let n = 1; n <= 2560; n++)
        expected.set(
          `${sid(2 * (n % 128) + 1)}:${sid(2 * (n % 128) + 2)}`,
          new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
        );
      expected.set(
        "1:9223372036854775807",
        new Date(Date.UTC(2026, 9, 1)).toISOString(),
      );
      for (const row of actual) {
        expect(row.room_id.split(":")).toContain(row.steam_id);
        expect(row.last_message_at).toBe(expected.get(row.room_id));
        expect(row.accepted_at).toBe(row.last_message_at);
      }
      expect(report.fullMigrationMs).toBeLessThan(15000);
    });
    it("defaults existing and new players OFF", async () => {
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM players WHERE allow_message_requests",
          )
        ).rows[0].count,
      ).toBe("0");
      await pool.query(
        "INSERT INTO players(steam_id,name) VALUES($1,'New synthetic')",
        [sid(3510)],
      );
      expect(
        (
          await pool.query(
            "SELECT allow_message_requests FROM players WHERE steam_id=$1",
            [sid(3510)],
          )
        ).rows[0].allow_message_requests,
      ).toBe(false);
    });
    it("reapplication preserves opt-ins, existing conversation state and all source data", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=$1",
        [sid(1)],
      );
      await pool.query(
        "UPDATE direct_conversations SET accepted_at=NULL,declined_at=now(),is_open=false WHERE room_id=$1 AND steam_id=$2",
        [`${sid(1)}:${sid(2)}`, sid(1)],
      );
      const before = await fingerprint(),
        conversations = await rows();
      const state = (
        await pool.query(
          "SELECT room_id,steam_id::text,is_open,declined_at FROM direct_conversations ORDER BY room_id,steam_id",
        )
      ).rows;
      await pool.query("BEGIN");
      try {
        await pool.query(migration);
        await pool.query(migration);
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
      expect(await fingerprint()).toEqual(before);
      expect(await rows()).toEqual(conversations);
      expect(
        (
          await pool.query(
            "SELECT room_id,steam_id::text,is_open,declined_at FROM direct_conversations ORDER BY room_id,steam_id",
          )
        ).rows,
      ).toEqual(state);
      expect(
        (
          await pool.query(
            "SELECT allow_message_requests FROM players WHERE steam_id=$1",
            [sid(1)],
          )
        ).rows[0].allow_message_requests,
      ).toBe(true);
    });
    it("down disables consent without deleting notifications, conversations, history ledger or blocks", async () => {
      const before = await fingerprint(),
        conversations = await rows();
      await pool.query(
        "INSERT INTO direct_messages(id,room_id,from_steam_id) VALUES(gen_random_uuid(),$1,$2)",
        [`${sid(1)}:${sid(2)}`, sid(1)],
      );
      await pool.query(down);
      expect(await fingerprint()).toEqual(before);
      expect(await rows()).toEqual(conversations);
      expect(
        (await pool.query("SELECT count(*) FROM direct_messages")).rows[0]
          .count,
      ).toBe("1");
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM players WHERE allow_message_requests",
          )
        ).rows[0].count,
      ).toBe("0");
    });
    it("rolling back a failed migration transaction does not import or modify data", async () => {
      const before = await fingerprint(),
        conversations = await rows();
      await pool.query("BEGIN");
      try {
        const rollbackRoom = `${sid(1)}:${sid(3509)}`;
        await pool.query(
          "INSERT INTO notifications(type,entity_id,created_at) VALUES('ChatMessage',$1,now())",
          [`direct:${rollbackRoom}`],
        );
        await pool.query(migration);
        expect(
          (
            await pool.query(
              "SELECT count(*) FROM direct_conversations WHERE room_id=$1",
              [rollbackRoom],
            )
          ).rows[0].count,
        ).toBe("2");
        await expect(pool.query("SELECT 1/0")).rejects.toMatchObject({
          code: "22012",
        });
      } finally {
        await pool.query("ROLLBACK");
      }
      expect(await fingerprint()).toEqual(before);
      expect(await rows()).toEqual(conversations);
    });
    it("compares complete original/optimized results and EXPLAIN ANALYZE plans on the same fixture", async () => {
      if (process.env.MESSAGE_REQUESTS_BENCHMARK_ORIGINAL !== "1") return;
      const before = await fingerprint();
      async function explain(sql: string) {
        const client = await pool.connect();
        try {
          await client.query(
            "BEGIN; SET LOCAL statement_timeout='120s'; DELETE FROM direct_conversations",
          );
          const started = performance.now();
          const plan = (
            await client.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql)
          ).rows[0]["QUERY PLAN"][0];
          const elapsedMs = performance.now() - started;
          const result = stable(
            (
              await client.query(
                "SELECT room_id,steam_id::text,last_message_at,accepted_at FROM direct_conversations ORDER BY room_id,steam_id",
              )
            ).rows,
          );
          return { elapsedMs, plan, result };
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      const legacy = await explain(original),
        current = await explain(optimized);
      expect(current.result).toEqual(legacy.result);
      expect(current.result).toHaveLength(258);
      report.original = { elapsedMs: legacy.elapsedMs, plan: legacy.plan };
      report.optimized = { elapsedMs: current.elapsedMs, plan: current.plan };
      expect(current.elapsedMs).toBeLessThan(15000);
      expect(await fingerprint()).toEqual(before);
    }, 180000);
  },
);
