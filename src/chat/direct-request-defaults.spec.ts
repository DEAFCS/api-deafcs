import { Pool, PoolClient } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
const dbDescribe =
  process.env.MESSAGE_REQUESTS_TEST_PORT === "15437" ? describe : describe.skip;
const sql = readFileSync(
  join(
    __dirname,
    "../../hasura/migrations/default/1890000001000_message_requests_default_on/up.sql",
  ),
  "utf8",
);
const original = readFileSync(
  join(
    __dirname,
    "../../hasura/migrations/default/1890000000900_direct_message_requests/up.sql",
  ),
  "utf8",
);
dbDescribe(
  "one-time Message Requests default ON on disposable PostgreSQL",
  () => {
    let admin: Pool, pool: Pool, client: PoolClient;
    const database = "deafcs_defaults_qa_" + process.pid;
    const connection = { host: "127.0.0.1", port: 15437, user: "postgres" };
    const states = async () =>
      (
        await client.query(
          "SELECT steam_id::text,allow_message_requests FROM players ORDER BY steam_id",
        )
      ).rows;
    const defaults = async () =>
      (
        await client.query(
          "SELECT column_default FROM information_schema.columns WHERE table_name='players' AND column_name='allow_message_requests'",
        )
      ).rows[0].column_default;
    async function snapshot() {
      const result: any = {};
      for (const table of [
        "player_blocks",
        "notifications",
        "direct_messages",
        "direct_conversations",
        "chat_read_state",
        "friends",
      ]) {
        result[table] = (
          await client.query("SELECT * FROM " + table + " ORDER BY 1")
        ).rows;
      }
      result.players = (
        await client.query(
          "SELECT steam_id,name,avatar_url,custom_avatar_url FROM players ORDER BY steam_id",
        )
      ).rows;
      return result;
    }
    beforeAll(async () => {
      admin = new Pool({ ...connection, database: "postgres" });
      await admin.query("CREATE DATABASE " + database);
      pool = new Pool({ ...connection, database });
      client = await pool.connect();
      await client.query(`CREATE SCHEMA hdb_catalog; CREATE TABLE hdb_catalog.schema_migrations(version bigint,dirty boolean);
   CREATE TABLE players(steam_id bigint PRIMARY KEY,name text,avatar_url text,custom_avatar_url text);
   CREATE TABLE friends(player_steam_id bigint,other_player_steam_id bigint,status text);
   CREATE TABLE player_blocks(blocker_steam_id bigint,blocked_steam_id bigint);
   CREATE TABLE notifications(id uuid PRIMARY KEY,type text,entity_id text,created_at timestamptz DEFAULT now());`);
      await client.query(original);
    });
    beforeEach(async () => {
      await client.query(
        "TRUNCATE direct_messages,direct_conversations,chat_read_state,friends,player_blocks,notifications,players,hdb_catalog.schema_migrations RESTART IDENTITY CASCADE",
      );
      await client.query(
        "ALTER TABLE players ALTER COLUMN allow_message_requests SET DEFAULT false",
      );
      await client.query(
        "INSERT INTO players(steam_id,name,allow_message_requests) VALUES(1,'untouched',false),(2,'opted in',true),(3,'manual OFF',false)",
      );
      await client.query(
        "INSERT INTO player_blocks VALUES(1,2); INSERT INTO notifications(id,type,entity_id) VALUES('00000000-0000-0000-0000-000000000001','ChatMessage','direct:1:2'); INSERT INTO direct_conversations(room_id,steam_id,accepted_at) VALUES('1:2',1,now()); INSERT INTO direct_messages(id,room_id,from_steam_id) VALUES('00000000-0000-0000-0000-000000000002','1:2',1); INSERT INTO chat_read_state(thread,steam_id) VALUES('direct:1:2',1)",
      );
    });
    afterAll(async () => {
      client?.release();
      await pool?.end();
      if (admin) {
        await admin.query("DROP DATABASE " + database);
        await admin.end();
      }
    });
    it("enables exactly the two OFF accounts and leaves unrelated data intact", async () => {
      const before = await snapshot();
      const notices: string[] = [];
      const notice = (n: any) => notices.push(n.message);
      client.on("notice", notice);
      try {
        await client.query(sql);
      } finally {
        client.off("notice", notice);
      }
      expect(notices).toContain(
        "Message Requests default ON: 2 existing accounts enabled",
      );
      expect((await states()).every((r) => r.allow_message_requests)).toBe(
        true,
      );
      expect(await snapshot()).toEqual(before);
      expect(await defaults()).toBe("true");
    });
    it("defaults a new registration to ON", async () => {
      await client.query(sql);
      await client.query("INSERT INTO players(steam_id,name) VALUES(4,'new')");
      expect(
        (await states()).find((r) => r.steam_id === "4").allow_message_requests,
      ).toBe(true);
    });
    it("keeps later OFF on a direct SQL retry before the ledger is recorded", async () => {
      await client.query(sql);
      await client.query(
        "UPDATE players SET allow_message_requests=false WHERE steam_id=3",
      );
      await client.query(sql);
      expect(
        (await states()).find((r) => r.steam_id === "3").allow_message_requests,
      ).toBe(false);
    });
    it("keeps OFF after an applied migration, even if an old default is restored", async () => {
      await client.query(sql);
      await client.query(
        "INSERT INTO hdb_catalog.schema_migrations VALUES(1890000001000,false); UPDATE players SET allow_message_requests=false WHERE steam_id=3; ALTER TABLE players ALTER COLUMN allow_message_requests SET DEFAULT false",
      );
      await client.query(sql);
      expect(
        (await states()).find((r) => r.steam_id === "3").allow_message_requests,
      ).toBe(false);
      expect(await defaults()).toBe("true");
    });
    it("persists manual OFF through a fresh database connection", async () => {
      await client.query(sql);
      await client.query(
        "UPDATE players SET allow_message_requests=false WHERE steam_id=3",
      );
      const fresh = new Pool({ ...connection, database });
      try {
        expect(
          (
            await fresh.query(
              "SELECT allow_message_requests FROM players WHERE steam_id=3",
            )
          ).rows[0].allow_message_requests,
        ).toBe(false);
      } finally {
        await fresh.end();
      }
    });
    it("rolls back both consent updates and the default atomically", async () => {
      const before = await states();
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("ROLLBACK");
      expect(await states()).toEqual(before);
      expect(await defaults()).toBe("false");
    });
    it("retains bidirectional blocks, request limits and disabled-account refusal", async () => {
      await client.query(sql);
      expect(
        (
          await client.query(
            "SELECT direct_message_refusal('1:2',1) AS refusal",
          )
        ).rows[0].refusal,
      ).toBe("blocked");
      expect(
        (
          await client.query(
            "SELECT direct_message_refusal('1:2',2) AS refusal",
          )
        ).rows[0].refusal,
      ).toBe("blocked");
      await client.query(
        "UPDATE players SET allow_message_requests=false WHERE steam_id=3",
      );
      expect(
        (
          await client.query(
            "SELECT direct_message_refusal('2:3',2) AS refusal",
          )
        ).rows[0].refusal,
      ).toBe("requests_off");
      await client.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=3; INSERT INTO direct_messages(id,room_id,from_steam_id) VALUES('00000000-0000-0000-0000-000000000003','2:3',2)",
      );
      expect(
        (
          await client.query(
            "SELECT direct_message_refusal('2:3',2) AS refusal",
          )
        ).rows[0].refusal,
      ).toBe("awaiting_reply");
    });
    it("rejects an unexpected default without changing accounts", async () => {
      const before = await states();
      await client.query(
        "ALTER TABLE players ALTER COLUMN allow_message_requests DROP DEFAULT",
      );
      await expect(client.query(sql)).rejects.toThrow(
        "Unexpected Message Requests default",
      );
      expect(await states()).toEqual(before);
    });
  },
);
