import { Pool } from "pg";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DirectRequestsService,
  directParties,
} from "./direct-requests.service";

// Explicit localhost-only disposable database. Never reads API .env or a
// production connection string. Enabled only by the local QA runner.
const dbDescribe =
  process.env.MESSAGE_REQUESTS_TEST_PORT === "15437" ? describe : describe.skip;
describe("canonical direct request rooms", () => {
  it.each(["1:1", "2:1", "1:2:3", "1:x", "0:2", "1:9223372036854775808"])(
    "rejects %s",
    (room) => expect(directParties(room)).toBeNull(),
  );
  it("keeps canonical participant identity", () =>
    expect(directParties("1:2")).toEqual(["1", "2"]));
});
dbDescribe("upstream request policy on isolated PostgreSQL", () => {
  let pool: Pool;
  let service: DirectRequestsService;
  let adapter: any;
  const user = (id: string) => ({ steam_id: id }) as any;
  const content = new Map<string, string>();
  let delivered: string[];
  async function send(from = "1", room = "1:2", retryId?: string) {
    return service.send(
      room,
      user(from),
      async (context) => {
        const id = retryId ?? randomUUID();
        await context.record(id);
        content.set(id, "test-only message");
        context.rollback.push(async () => {
          content.delete(id);
        });
        context.afterCommit.push(async () => {
          delivered.push(context.request ? "inbox" : "normal");
        });
        return { accepted: true };
      },
      retryId,
    );
  }
  beforeAll(async () => {
    const admin = new Pool({
      host: "127.0.0.1",
      port: 15437,
      user: "postgres",
      database: "postgres",
    });
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='deafcs_requests_qa'",
    );
    if (!exists.rows.length)
      await admin.query("CREATE DATABASE deafcs_requests_qa");
    await admin.end();
    pool = new Pool({
      host: "127.0.0.1",
      port: 15437,
      user: "postgres",
      database: "deafcs_requests_qa",
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS players(steam_id bigint PRIMARY KEY,name text,avatar_url text,custom_avatar_url text);
      CREATE TABLE IF NOT EXISTS friends(player_steam_id bigint,other_player_steam_id bigint,status text);
      CREATE TABLE IF NOT EXISTS player_blocks(blocker_steam_id bigint,blocked_steam_id bigint);
      CREATE TABLE IF NOT EXISTS notifications(id uuid PRIMARY KEY,type text,entity_id text,created_at timestamptz DEFAULT now());
      INSERT INTO players(steam_id,name) VALUES(1,'A'),(2,'B'),(3,'C') ON CONFLICT DO NOTHING;`);
    await pool.query(
      readFileSync(
        join(
          __dirname,
          "../../hasura/migrations/default/1890000000900_direct_message_requests/up.sql",
        ),
        "utf8",
      ),
    );
    adapter = {
      query: async (sql: string, args: any[]) =>
        (await pool.query(sql, args)).rows,
      transaction: async (fn: any) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await fn(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
    service = new DirectRequestsService(adapter);
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE direct_messages,direct_conversations,chat_read_state,friends,player_blocks,notifications RESTART IDENTITY",
    );
    await pool.query("UPDATE players SET allow_message_requests=false");
    content.clear();
    delivered = [];
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("keeps existing accounts opted out and refuses non-friend initiation", async () => {
    expect(
      (
        await pool.query("SELECT allow_message_requests FROM players")
      ).rows.every((row) => !row.allow_message_requests),
    ).toBe(true);
    expect(await service.canView("1:2", user("1"))).toBe(false);
    expect(await send()).toMatchObject({
      accepted: false,
      errorCode: "not_allowed",
    });
    expect(content.size).toBe(0);
  });
  it("friends always use normal messages even with requests disabled", async () => {
    await pool.query("INSERT INTO friends VALUES(2,1,'Accepted')");
    expect(await service.canView("1:2", user("1"))).toBe(true);
    expect(await send()).toEqual({ accepted: true });
    expect(await send()).toEqual({ accepted: true });
    expect(delivered).toEqual(["normal", "normal"]);
    expect((await service.conversations(user("2")))[0].request).toBe(false);
  });
  it("delivers an enabled initial request only into the recipient inbox", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    expect(await send()).toEqual({ accepted: true });
    expect(delivered).toEqual(["inbox"]);
    expect(await service.conversations(user("2"))).toMatchObject([
      { request: true, unread: 1, peer: { steam_id: "1" } },
    ]);
    expect(await service.conversations(user("1"))).toMatchObject([
      { request: false, awaitingReply: true },
    ]);
    expect(await send()).toMatchObject({
      accepted: false,
      errorCode: "awaiting_reply",
    });
  });
  it("serializes concurrent initial sends so only one pending message exists", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => send()),
    );
    expect(outcomes.filter((row) => row.accepted)).toHaveLength(1);
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM direct_messages")).rows[0]
          .count,
      ),
    ).toBe(1);
    expect(delivered).toEqual(["inbox"]);
  });
  it("reply accepts a pending request even after the recipient disables requests", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    await pool.query(
      "UPDATE players SET allow_message_requests=false WHERE steam_id=2",
    );
    expect(await send("2")).toEqual({ accepted: true });
    expect(await send()).toEqual({ accepted: true });
    expect((await service.conversations(user("2")))[0]).toMatchObject({
      request: false,
      awaitingReply: false,
    });
    expect(delivered).toEqual(["inbox", "normal", "normal"]);
  });
  it("declining hides only the recipient request and does not replenish the sender allowance", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    await service.decline("1:2", user("2"));
    expect(await service.conversations(user("2"))).toEqual([]);
    expect((await service.conversations(user("1")))[0].awaitingReply).toBe(
      true,
    );
    expect(await send()).toMatchObject({
      accepted: false,
      errorCode: "awaiting_reply",
    });
    expect(content.size).toBe(1);
    expect(await send("2")).toEqual({ accepted: true });
    expect((await service.conversations(user("2")))[0].request).toBe(false);
  });
  it.each([
    [1, 2],
    [2, 1],
  ])(
    "blocks requests, history and inboxes in either direction: %s -> %s",
    async (a, b) => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      await send();
      await pool.query("INSERT INTO player_blocks VALUES($1,$2)", [a, b]);
      expect(await send()).toMatchObject({
        accepted: false,
        errorCode: "not_allowed",
      });
      expect(await service.canView("1:2", user("1"))).toBe(false);
      expect(await service.canView("1:2", user("2"))).toBe(false);
      expect(await service.conversations(user("2"))).toEqual([]);
      await pool.query("DELETE FROM player_blocks");
      expect(await service.canView("1:2", user("2"))).toBe(true);
      expect((await service.conversations(user("2")))[0].request).toBe(true);
      expect(await send()).toMatchObject({
        accepted: false,
        errorCode: "awaiting_reply",
      });
      expect(content.size).toBe(1);
    },
  );
  it("outsiders cannot inspect or decline either pending or accepted conversations", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    expect(await service.canView("1:2", user("3"))).toBe(false);
    expect(await send("3")).toMatchObject({ accepted: false });
    await service.decline("1:2", user("3"));
    expect((await service.conversations(user("2")))[0].request).toBe(true);
    expect(await service.conversations(user("3"))).toEqual([]);
    await send("2");
    expect(await service.canView("1:2", user("3"))).toBe(false);
  });
  it("rollback removes a failed cache write and does not spend the initial allowance", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await expect(
      service.send("1:2", user("1"), async (context) => {
        const id = randomUUID();
        await context.record(id);
        content.set(id, "failed");
        context.rollback.push(async () => {
          content.delete(id);
        });
        throw new Error("test cache failure");
      }),
    ).rejects.toThrow("test cache failure");
    expect(content.size).toBe(0);
    expect(
      (await pool.query("SELECT count(*) FROM direct_messages")).rows[0].count,
    ).toBe("0");
    expect(await send()).toEqual({ accepted: true });
  });
  it("deleting/expiring the initial content cannot be used to send another pending message", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    content.clear();
    expect(await send()).toMatchObject({
      accepted: false,
      errorCode: "awaiting_reply",
    });
  });
  it("acknowledges a stable video retry without another message or delivery", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const id = randomUUID();
    expect(await send("1", "1:2", id)).toEqual({ accepted: true });
    expect(await send("1", "1:2", id)).toEqual({ accepted: true });
    expect(content.size).toBe(1);
    expect(delivered).toEqual(["inbox"]);
  });
  it("retains read state without accepting a request merely because it was opened", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    await service.markRead("1:2", user("2"));
    expect((await service.conversations(user("2")))[0]).toMatchObject({
      request: true,
      unread: 0,
    });
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  async function waitForLock(pid: number) {
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [pid],
      );
      if (rows[0]?.wait_event_type === "Lock") return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("expected competing mutation to wait on send lock");
  }
  it.each(["consent", "friendship"])(
    "serializes a later %s removal behind the authorized send",
    async (change) => {
      if (change === "consent")
        await pool.query(
          "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
        );
      else await pool.query("INSERT INTO friends VALUES(1,2,'Accepted')");
      const entered = deferred(),
        release = deferred();
      const client = await pool.connect();
      const sending = service.send("1:2", user("1"), async (ctx) => {
        entered.resolve();
        await release.promise;
        await ctx.record(randomUUID());
        return { accepted: true };
      });
      await entered.promise;
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      const changing = client.query(
        change === "consent"
          ? "UPDATE players SET allow_message_requests=false WHERE steam_id=2"
          : "DELETE FROM friends",
      );
      try {
        await waitForLock(pid);
      } finally {
        release.resolve();
      }
      expect(await sending).toEqual({ accepted: true });
      await changing;
      client.release();
      expect((await service.conversations(user("2")))[0].request).toBe(
        change === "consent",
      );
    },
  );
  it.each(["consent", "friendship"])(
    "refuses when %s removal commits before sending",
    async (change) => {
      if (change === "consent") {
        await pool.query(
          "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
        );
        await pool.query(
          "UPDATE players SET allow_message_requests=false WHERE steam_id=2",
        );
      } else {
        await pool.query("INSERT INTO friends VALUES(1,2,'Accepted')");
        await pool.query("DELETE FROM friends");
      }
      expect(await send()).toMatchObject({ accepted: false });
      expect(content.size).toBe(0);
    },
  );
  it("rechecks a block committed after ledger recording and rolls back the entire send", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const result = await service.send("1:2", user("1"), async (ctx) => {
      const id = randomUUID();
      await ctx.record(id);
      content.set(id, "never deliver");
      ctx.rollback.push(async () => {
        content.delete(id);
      });
      ctx.afterCommit.push(async () => {
        delivered.push("unsafe");
      });
      await pool.query("INSERT INTO player_blocks VALUES(2,1)");
      return { accepted: true };
    });
    expect(result).toMatchObject({ accepted: false, errorCode: "not_allowed" });
    expect(content.size).toBe(0);
    expect(delivered).toEqual([]);
    expect(
      (await pool.query("SELECT count(*) FROM direct_messages")).rows[0].count,
    ).toBe("0");
  });
  it("does not let block/unblock grant another initial message or lose read state", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    await service.markRead("1:2", user("2"));
    await pool.query("INSERT INTO player_blocks VALUES(2,1)");
    await service.markRead("1:2", user("1"));
    expect(
      (await pool.query("SELECT count(*) FROM chat_read_state")).rows[0].count,
    ).toBe("1");
    await pool.query("DELETE FROM player_blocks");
    expect(await send()).toMatchObject({ errorCode: "awaiting_reply" });
    expect((await service.conversations(user("2")))[0]).toMatchObject({
      request: true,
      unread: 0,
    });
  });
  it("a video retry stays idempotent after acceptance but cannot bypass a new block", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const id = randomUUID();
    await send("1", "1:2", id);
    await send("2");
    expect(await send("1", "1:2", id)).toEqual({ accepted: true });
    expect(delivered).toEqual(["inbox", "normal"]);
    await pool.query("INSERT INTO player_blocks VALUES(2,1)");
    expect(await send("1", "1:2", id)).toMatchObject({
      accepted: false,
      errorCode: "not_allowed",
    });
  });
  it("keeps committed content when delivery fails and logs the failure", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const warn = jest.fn();
    const policy = new DirectRequestsService(adapter, warn);
    expect(
      await policy.send("1:2", user("1"), async (ctx) => {
        const id = randomUUID();
        await ctx.record(id);
        content.set(id, "committed");
        ctx.rollback.push(async () => {
          content.delete(id);
        });
        ctx.afterCommit.push(async () => {
          throw Error("pubsub offline");
        });
        return { accepted: true };
      }),
    ).toEqual({ accepted: true });
    expect(content.size).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(await send()).toMatchObject({ errorCode: "awaiting_reply" });
  });
  it("rolls back a database failure after Redis persistence, allowing a clean retry", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    let first = true;
    const policy = new DirectRequestsService({
      ...adapter,
      transaction: async (fn: any) =>
        adapter.transaction(async (client: any) => {
          const r = await fn(client);
          if (first) {
            first = false;
            throw Error("commit rejected");
          }
          return r;
        }),
    });
    await expect(
      policy.send("1:2", user("1"), async (ctx) => {
        const id = randomUUID();
        await ctx.record(id);
        content.set(id, "uncommitted");
        ctx.rollback.push(async () => {
          content.delete(id);
        });
        return { accepted: true };
      }),
    ).rejects.toThrow("commit rejected");
    expect(content.size).toBe(0);
    expect(await send()).toEqual({ accepted: true });
  });
  it("reconciles a successful commit with a lost acknowledgement without erasing content", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    let first = true;
    const policy = new DirectRequestsService({
      ...adapter,
      transaction: async (fn: any) => {
        const r = await adapter.transaction(fn);
        if (first) {
          first = false;
          throw Error("lost commit acknowledgement");
        }
        return r;
      },
    });
    expect(
      await policy.send("1:2", user("1"), async (ctx) => {
        const id = randomUUID();
        await ctx.record(id);
        content.set(id, "committed");
        ctx.rollback.push(async () => {
          content.delete(id);
        });
        ctx.afterCommit.push(async () => {
          delivered.push("inbox");
        });
        return { accepted: true };
      }),
    ).toEqual({ accepted: true });
    expect(content.size).toBe(1);
    expect(delivered).toEqual(["inbox"]);
    expect(await send()).toMatchObject({ errorCode: "awaiting_reply" });
  });
  it("rejects missing actors and noncanonical rooms at the SQL boundary", async () => {
    for (const room of [
      null,
      "1:2:3",
      "1:x",
      "2:1",
      "1:1",
      "1:9223372036854775808",
    ]) {
      const {
        rows: [row],
      } = await pool.query(
        "SELECT can_view_direct_room($1,1) AS visible,direct_message_refusal($1,1) AS refusal",
        [room],
      );
      expect(row).toEqual({ visible: false, refusal: "blocked" });
    }
    expect(
      (
        await pool.query(
          "SELECT can_view_direct_room($1,NULL) AS visible,direct_message_refusal($1,NULL) AS refusal",
          ["1:2"],
        )
      ).rows[0],
    ).toEqual({ visible: false, refusal: "blocked" });
    expect(await service.conversations(undefined)).toEqual([]);
    expect(await service.send("1:999999999", user("1"), jest.fn())).toMatchObject({
      accepted: false,
    });
  });
  it("reapplying the migration preserves opt-ins and imports legacy accepted conversations without duplicates", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await pool.query(
      "INSERT INTO notifications(id,type,entity_id) VALUES($1,'ChatMessage','direct:1:2')",
      [randomUUID()],
    );
    const migration = readFileSync(
      join(
        __dirname,
        "../../hasura/migrations/default/1890000000900_direct_message_requests/up.sql",
      ),
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
    expect(
      (
        await pool.query(
          "SELECT allow_message_requests FROM players WHERE steam_id=2",
        )
      ).rows[0].allow_message_requests,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM direct_conversations WHERE accepted_at IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe("2");
    expect(await send()).toEqual({ accepted: true });
    expect(delivered).toEqual(["normal"]);
  });

  it.each(["user", "administrator", "match_organizer"])(
    "enforces own-account consent for Hasura %s without broadening other permissions",
    async (role) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('hasura.user',$1,true)", [
          JSON.stringify({ "x-hasura-user-id": "1", "x-hasura-role": role }),
        ]);
        await c.query(
          "UPDATE players SET allow_message_requests=true WHERE steam_id=1",
        );
        await expect(
          c.query(
            "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );
  it("imports no malformed, noncanonical or missing-peer legacy room", async () => {
    for (const room of [
      "direct:1:2:3",
      "direct:2:1",
      "direct:1:1",
      "direct:1:999999999",
      "direct:1:9223372036854775808",
      "bad",
    ])
      await pool.query(
        "INSERT INTO notifications VALUES($1,'ChatMessage',$2,now())",
        [randomUUID(), room],
      );
    await pool.query(
      readFileSync(
        join(
          __dirname,
          "../../hasura/migrations/default/1890000000900_direct_message_requests/up.sql",
        ),
        "utf8",
      ),
    );
    expect(
      (await pool.query("SELECT count(*) FROM direct_conversations")).rows[0]
        .count,
    ).toBe("0");
  });

  it("a recipient cannot retry a sender-owned video id to accept or overwrite a request", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    const id = randomUUID();
    await send("1", "1:2", id);
    await expect(send("2", "1:2", id)).rejects.toMatchObject({ code: "23505" });
    expect(content.size).toBe(1);
    expect((await service.conversations(user("2")))[0].request).toBe(true);
  });
  it("the down migration disables new consent without deleting pending, accepted or block records", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
    );
    await send();
    await pool.query("INSERT INTO player_blocks VALUES(3,1)");
    await pool.query(
      readFileSync(
        join(
          __dirname,
          "../../hasura/migrations/default/1890000000900_direct_message_requests/down.sql",
        ),
        "utf8",
      ),
    );
    expect(
      (
        await pool.query(
          "SELECT allow_message_requests FROM players WHERE steam_id=2",
        )
      ).rows[0].allow_message_requests,
    ).toBe(false);
    expect(
      (await pool.query("SELECT count(*) FROM direct_messages")).rows[0].count,
    ).toBe("1");
    expect(
      (await pool.query("SELECT count(*) FROM player_blocks")).rows[0].count,
    ).toBe("1");
    expect((await service.conversations(user("2")))[0].request).toBe(true);
    expect(await send("2")).toEqual({ accepted: true });
  });

  it("applies on a populated legacy database, preserves blocks/conversations and defaults accounts off", async () => {
    const database = "deafcs_requests_fresh_qa_" + Date.now();
    if (!/^deafcs_requests_fresh_qa_[0-9]+$/.test(database))
      throw Error("invalid QA database");
    const admin = new Pool({
      host: "127.0.0.1",
      port: 15437,
      user: "postgres",
      database: "postgres",
    });
    await admin.query('CREATE DATABASE "' + database + '"');
    await admin.end();
    const fresh = new Pool({
      host: "127.0.0.1",
      port: 15437,
      user: "postgres",
      database,
    });
    try {
      await fresh.query(
        "CREATE TABLE players(steam_id bigint PRIMARY KEY,name text,avatar_url text,custom_avatar_url text); CREATE TABLE friends(player_steam_id bigint,other_player_steam_id bigint,status text); CREATE TABLE player_blocks(blocker_steam_id bigint,blocked_steam_id bigint); CREATE TABLE notifications(id uuid PRIMARY KEY,type text,entity_id text,created_at timestamptz DEFAULT now());",
      );

      await fresh.query(
        "INSERT INTO players(steam_id,name) SELECT n,'existing' FROM generate_series(3,1000) n; INSERT INTO friends VALUES(3,4,'Accepted'); INSERT INTO player_blocks VALUES(5,6)",
      );
      await fresh.query(
        "INSERT INTO notifications(id,type,entity_id) VALUES($1,'ChatMessage','direct:3:4'),($2,'ChatMessage','global:global')",
        [randomUUID(), randomUUID()],
      );
      await fresh.query(
        readFileSync(
          join(
            __dirname,
            "../../hasura/migrations/default/1890000000900_direct_message_requests/up.sql",
          ),
          "utf8",
        ),
      );
      await fresh.query(
        "INSERT INTO players(steam_id,name) VALUES(1,'A'),(2,'B')",
      );
      expect(
        (
          await fresh.query("SELECT allow_message_requests FROM players")
        ).rows.every((r) => r.allow_message_requests === false),
      ).toBe(true);
      expect(
        (
          await fresh.query(
            "SELECT can_view_direct_room('1:2',1) AS visible,direct_message_refusal('1:2',1) AS refusal",
          )
        ).rows[0],
      ).toEqual({ visible: false, refusal: "requests_off" });

      expect(
        (await fresh.query("SELECT count(*) FROM player_blocks")).rows[0].count,
      ).toBe("1");
      expect(
        (await fresh.query("SELECT count(*) FROM notifications")).rows[0].count,
      ).toBe("2");
      expect(
        (
          await fresh.query(
            "SELECT count(*) FROM direct_conversations WHERE accepted_at IS NOT NULL",
          )
        ).rows[0].count,
      ).toBe("2");
      const indexes = (
        await fresh.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname='public'",
        )
      ).rows.map((r) => r.indexname);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "direct_messages_pkey",
          "direct_messages_room_created_idx",
          "direct_conversations_pkey",
          "direct_conversations_owner_idx",
          "chat_read_state_pkey",
        ]),
      );
    } finally {
      await fresh.end();
    }
  });

  it("does not let normal conversation volume hide a pending request at the endpoint limit", async () => {
    await pool.query(
      "UPDATE players SET allow_message_requests=true WHERE steam_id=1",
    );
    await send("2");
    await pool.query(
      "INSERT INTO players(steam_id,name) SELECT n,'fixture' FROM generate_series(4,103) n ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO direct_conversations(room_id,steam_id,accepted_at,last_message_at) SELECT '1:'||n,1,now(),now()+interval '1 minute' FROM generate_series(4,103) n",
    );
    const rows = await service.conversations(user("1"));
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({ roomId: "1:2", request: true });
  });

  it("hides uncommitted new history but preserves legacy bodies, with PostgreSQL authoritative", async () => {
    await pool.query("UPDATE players SET allow_message_requests=true");
    const id = randomUUID(),
      legacy = { id: randomUUID(), message: "legacy Redis body" };
    const records = [legacy, { id, message: "orphan", directLedger: true }];
    expect(
      await service.filterCommittedMessages("1:2", user("2"), records),
    ).toEqual([legacy]);
    expect(
      await service.filterCommittedMessages("1:2", user("3"), records),
    ).toEqual([]);
    await service.send("1:2", user("1"), async (ctx) => {
      await ctx.record(id);
      return { accepted: true };
    });
    expect(
      await service.filterCommittedMessages("1:2", user("2"), records),
    ).toEqual([legacy, { id, message: "orphan" }]);
    await pool.query("INSERT INTO player_blocks VALUES(2,1)");
    expect(
      await service.filterCommittedMessages("1:2", user("2"), records),
    ).toEqual([]);
  });
  describe("ChatService integration with the real request transaction", () => {
    let chat: ChatService,
      redis: any,
      values: Map<string, string>,
      hashes: Map<string, Map<string, string>>,
      queue: any,
      notifications: jest.SpyInstance,
      warn: jest.Mock;
    beforeEach(() => {
      values = new Map();
      hashes = new Map();
      warn = jest.fn();
      redis = {
        eval: jest.fn().mockResolvedValue(1),
        get: jest.fn(async (k: string) => values.get(k) ?? null),
        set: jest.fn(async (k: string, v: string, ...args: any[]) => {
          if (args.includes("NX") && values.has(k)) return null;
          values.set(k, v);
          return "OK";
        }),
        del: jest.fn(async (...keys: string[]) =>
          keys.reduce((n, k) => n + Number(values.delete(k)), 0),
        ),
        expire: jest.fn().mockResolvedValue(1),
        hset: jest.fn(async (k: string, f: string, v: string) => {
          if (!hashes.has(k)) hashes.set(k, new Map());
          hashes.get(k)!.set(f, v);
          return 1;
        }),
        hsetnx: jest.fn(async (k: string, f: string, v: string) => {
          if (hashes.get(k)?.has(f)) return 0;
          if (!hashes.has(k)) hashes.set(k, new Map());
          hashes.get(k)!.set(f, v);
          return 1;
        }),
        hget: jest.fn(
          async (k: string, f: string) => hashes.get(k)?.get(f) ?? null,
        ),
        hdel: jest.fn(async (k: string, f: string) =>
          Number(hashes.get(k)?.delete(f) ?? false),
        ),
        sendCommand: jest.fn().mockResolvedValue([1]),
        publish: jest.fn().mockResolvedValue(1),
      };
      queue = {
        getJob: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockResolvedValue(undefined),
      };
      chat = new ChatService(
        { warn, log: jest.fn() } as any,
        {} as any,
        {} as any,
        adapter,
        { getConnection: () => redis } as any,
        {} as any,
        { isBlockedEitherDirection: jest.fn().mockResolvedValue(false) } as any,
        { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
        {} as any,
        queue,
      );
      jest
        .spyOn(chat as any, "getAllUsersInLobby")
        .mockResolvedValue([
          { steamId: "1" },
          { steamId: "2" },
          { steamId: "3" },
        ]);
      notifications = jest
        .spyOn(chat as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);
    });
    const player = (id = "1") =>
      ({
        steam_id: id,
        name: id === "1" ? "A" : "B",
        role: "verified_user",
      }) as any;
    const sendChat = (id = "1", video?: string) =>
      chat.sendMessageToChat(
        ChatLobbyType.Direct,
        "1:2",
        player(id),
        video ? "" : "hello",
        true,
        "tab",
        undefined,
        "website",
        undefined,
        video,
      );
    const events = () =>
      redis.publish.mock.calls.map((call: any[]) => JSON.parse(call[1]));
    it("writes the same valid ID to PostgreSQL and Redis and sends pending content only to authorized joined participants", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      expect(await sendChat()).toEqual({ accepted: true });
      const ledger = (await pool.query("SELECT id FROM direct_messages"))
        .rows[0].id;
      expect(hashes.get("chat_direct_1:2")?.has(ledger)).toBe(true);
      expect(
        events()
          .filter((e: any) => e.event === "lobby:direct:1:2:chat")
          .map((e: any) => e.steamId),
      ).toEqual(["1", "2"]);
      expect(
        events().find(
          (e: any) => e.steamId === "2" && e.event === "direct:incoming",
        ).data,
      ).toMatchObject({ request: true, awaitingReply: false });
      expect(
        events().find(
          (e: any) => e.steamId === "1" && e.event === "direct:incoming",
        ).data,
      ).toMatchObject({ request: false, awaitingReply: true });
      expect(notifications).not.toHaveBeenCalled();
      expect(events().some((e: any) => e.steamId === "3")).toBe(false);
      await sendChat("2");
      expect(
        events()
          .filter(
            (e: any) => e.steamId === "1" && e.event === "direct:incoming",
          )
          .at(-1).data.awaitingReply,
      ).toBe(false);
      expect(notifications).toHaveBeenCalledTimes(1);
    });
    it("suppresses request metadata and message delivery if a block commits immediately after the send", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      const tx = adapter.transaction;
      let once = true;
      const spy = jest
        .spyOn(adapter, "transaction")
        .mockImplementation(async (fn: any) => {
          const r = await tx(fn);
          if (once) {
            once = false;
            await pool.query("INSERT INTO player_blocks VALUES(2,1)");
          }
          return r;
        });
      try {
        expect(await sendChat()).toEqual({ accepted: true });
        expect(events()).toEqual([]);
        expect(notifications).not.toHaveBeenCalled();
        expect(await chat.directRequests.canView("1:2", player())).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
    it("rate-limits before opening a request transaction and charges each attempt once", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      const tx = jest.spyOn(adapter, "transaction");
      redis.eval.mockResolvedValueOnce(1);
      expect(await sendChat()).toEqual({ accepted: true });
      expect(redis.eval).toHaveBeenCalledTimes(1);
      tx.mockClear();
      redis.eval.mockResolvedValueOnce(6);
      expect(await sendChat()).toMatchObject({
        accepted: false,
        rateLimited: true,
      });
      expect(tx).not.toHaveBeenCalled();
      tx.mockRestore();
    });
    it("compensates a rejected video commit and retries the same uploaded draft exactly once", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      const draft = randomUUID(),
        media = randomUUID(),
        createdAt = Date.now();
      values.set(
        "chat_video_draft:" + draft,
        JSON.stringify({
          state: "ready",
          ownerSteamId: "1",
          type: "direct",
          roomId: "1:2",
          mediaId: media,
          createdAt,
        }),
      );
      values.set(
        "chat_video_media:" + media,
        JSON.stringify({
          id: media,
          type: "video",
          ownerSteamId: "1",
          chatType: "direct",
          roomId: "1:2",
          objectKey: "chat-video/" + media + ".webm",
          mimeType: "video/webm",
          durationMs: 1000,
          size: 256,
        }),
      );
      jest.spyOn(chat as any, "hasLobbyPermission").mockResolvedValue(true);
      const tx = adapter.transaction;
      let once = true;
      const spy = jest
        .spyOn(adapter, "transaction")
        .mockImplementation(async (fn: any) =>
          tx(async (client: any) => {
            const r = await fn(client);
            if (once) {
              once = false;
              throw Error("commit rejected");
            }
            return r;
          }),
        );
      try {
        await expect(sendChat("1", draft)).rejects.toThrow("commit rejected");
      } finally {
        spy.mockRestore();
      }
      expect(hashes.get("chat_direct_1:2")?.size ?? 0).toBe(0);
      expect(JSON.parse(values.get("chat_video_draft:" + draft)!).state).toBe(
        "ready",
      );
      expect(values.has("chat_video_claim:" + draft)).toBe(false);
      expect(values.has("chat_video_media:" + media)).toBe(true);
      expect(queue.add.mock.calls.at(-1)[2].delay).toBeLessThan(3600000);
      expect(await sendChat("1", draft)).toEqual({ accepted: true });
      expect(await sendChat("1", draft)).toEqual({ accepted: true });
      expect(
        (await pool.query("SELECT count(*) FROM direct_messages")).rows[0]
          .count,
      ).toBe("1");
      expect(hashes.get("chat_direct_1:2")?.size).toBe(1);
    });

    it("releases its video claim even if rollback cleanup rescheduling fails", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      const draft = randomUUID(),
        media = randomUUID();
      values.set(
        "chat_video_draft:" + draft,
        JSON.stringify({
          state: "ready",
          ownerSteamId: "1",
          type: "direct",
          roomId: "1:2",
          mediaId: media,
          createdAt: Date.now(),
        }),
      );
      values.set(
        "chat_video_media:" + media,
        JSON.stringify({
          id: media,
          type: "video",
          ownerSteamId: "1",
          chatType: "direct",
          roomId: "1:2",
          objectKey: "chat-video/" + media + ".webm",
        }),
      );
      jest.spyOn(chat as any, "hasLobbyPermission").mockResolvedValue(true);
      queue.add
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Error("cleanup queue offline"));
      const tx = adapter.transaction;
      let once = true;
      const spy = jest
        .spyOn(adapter, "transaction")
        .mockImplementation(async (fn: any) =>
          tx(async (client: any) => {
            const r = await fn(client);
            if (once) {
              once = false;
              throw Error("commit rejected");
            }
            return r;
          }),
        );
      try {
        await expect(sendChat("1", draft)).rejects.toThrow("commit rejected");
      } finally {
        spy.mockRestore();
      }
      expect(values.has("chat_video_claim:" + draft)).toBe(false);
      expect(JSON.parse(values.get("chat_video_draft:" + draft)!).state).toBe(
        "ready",
      );
      expect(warn).toHaveBeenCalled();
      expect(await sendChat("1", draft)).toEqual({ accepted: true });
    });

    it("denies orphan attachment and video lookups until the matching ledger commits", async () => {
      await pool.query("UPDATE players SET allow_message_requests=true");
      const id = randomUUID(),
        media = randomUUID(),
        attachment = "0123456789abcdef";
      hashes.set(
        "chat_direct_1:2",
        new Map([
          [
            id,
            JSON.stringify({
              id,
              from: { steam_id: "1" },
              directLedger: true,
              media: { id: media },
            }),
          ],
        ]),
      );
      redis.hgetall = jest.fn(async (key: string) =>
        Object.fromEntries(hashes.get(key) ?? []),
      );
      values.set(
        "chat_video_media:" + media,
        JSON.stringify({ id: media, chatType: "direct", roomId: "1:2" }),
      );
      values.set(
        "chat_attachment:" + attachment,
        JSON.stringify({
          objectKey: "chat-attachments/1/test.png",
          contentType: "image/png",
          chatType: "direct",
          roomId: "1:2",
          directMessageId: id,
        }),
      );
      jest
        .spyOn(chat as any, "getUserData")
        .mockResolvedValue({ user: player("2") });
      jest
        .spyOn(chat as any, "getDeletedMessageIds")
        .mockResolvedValue(new Set());
      expect(
        await chat.getVideoMediaForViewer(media, player("2")),
      ).toBeUndefined();
      expect(
        await chat.getChatAttachmentForViewer(attachment, player("2")),
      ).toBeUndefined();
      await service.send("1:2", user("1"), async (ctx) => {
        await ctx.record(id);
        return { accepted: true };
      });
      expect(
        await chat.getVideoMediaForViewer(media, player("2")),
      ).toBeDefined();
      expect(
        await chat.getChatAttachmentForViewer(attachment, player("2")),
      ).toBeDefined();
      expect(
        await chat.getChatAttachmentForViewer(attachment, player("3")),
      ).toBeUndefined();
    });
    it("preserves an already-sent legacy video acknowledgement while adding its missing ledger", async () => {
      await pool.query(
        "INSERT INTO direct_conversations(room_id,steam_id,accepted_at) VALUES('1:2',1,now()),('1:2',2,now())",
      );
      const draft = randomUUID(),
        media = randomUUID();
      values.set(
        "chat_video_draft:" + draft,
        JSON.stringify({
          state: "sent",
          ownerSteamId: "1",
          type: "direct",
          roomId: "1:2",
          mediaId: media,
          createdAt: Date.now(),
          messageId: draft,
        }),
      );
      hashes.set(
        "chat_direct_1:2",
        new Map([
          [
            draft,
            JSON.stringify({
              id: draft,
              from: { steam_id: "1" },
              media: { id: media },
            }),
          ],
        ]),
      );
      expect(await sendChat("1", draft)).toEqual({ accepted: true });
      expect(await sendChat("1", draft)).toEqual({ accepted: true });
      expect(events()).toEqual([]);
      expect(
        (await pool.query("SELECT count(*) FROM direct_messages")).rows[0]
          .count,
      ).toBe("1");
    });
    it("cleans up only its attachment claim after a rejected database commit", async () => {
      await pool.query(
        "UPDATE players SET allow_message_requests=true WHERE steam_id=2",
      );
      const tx = adapter.transaction;
      let once = true;
      const spy = jest
        .spyOn(adapter, "transaction")
        .mockImplementation(async (fn: any) =>
          tx(async (client: any) => {
            const r = await fn(client);
            if (once) {
              once = false;
              throw Error("commit rejected");
            }
            return r;
          }),
        );
      try {
        await expect(
          chat.sendMessageToChat(
            ChatLobbyType.Direct,
            "1:2",
            player(),
            "hello",
            true,
            "tab",
            {
              url: "chat-attachments/1/0123456789abcdef.png",
              contentType: "image/png",
            },
          ),
        ).rejects.toThrow("commit rejected");
      } finally {
        spy.mockRestore();
      }
      expect(
        [...values.keys()].filter((k) => k.startsWith("chat_attachment")),
      ).toEqual([]);
      expect(hashes.get("chat_direct_1:2")?.size ?? 0).toBe(0);
    });
  });
});

describe("request endpoint and metadata security", () => {
  it.each(["directConversations", "declineDirect", "readDirect"])(
    "guards %s with the existing authenticated Steam session",
    (name) => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, ChatController.prototype[name]),
      ).toContain(SteamGuard);
    },
  );
  it("exposes no unauthenticated privacy switch and grants only owner-bound updates", () => {
    const yaml = require("js-yaml");
    const metadata = yaml.load(
      readFileSync(
        join(
          __dirname,
          "../../hasura/metadata/databases/default/tables/public_players.yaml",
        ),
        "utf8",
      ),
    );
    expect(
      metadata.select_permissions.find((p: any) => p.role === "guest")
        .permission.columns,
    ).not.toContain("allow_message_requests");
    const writers = metadata.update_permissions.filter((p: any) =>
      p.permission.columns.includes("allow_message_requests"),
    );
    expect(writers.map((p: any) => p.role)).toEqual([
      "administrator",
      "match_organizer",
      "user",
    ]);
    for (const p of writers.filter((p: any) => p.role === "user")) {
      expect(p.permission.filter).toEqual({
        steam_id: { _eq: "X-Hasura-User-Id" },
      });
      expect(p.permission.check).toEqual({
        steam_id: { _eq: "X-Hasura-User-Id" },
      });
    }
    const tracked = readFileSync(
      join(
        __dirname,
        "../../hasura/metadata/databases/default/tables/tables.yaml",
      ),
      "utf8",
    );
    expect(tracked).not.toMatch(/public_direct_(messages|conversations)\.yaml/);
  });
});

describe("direct request mutation origins", () => {
  let calls: any, controller: ChatController;
  beforeEach(() => {
    calls = { decline: jest.fn(), markRead: jest.fn() };
    controller = new ChatController(
      { directRequests: calls } as any,
      {} as any,
      {} as any,
      {
        get: () => ({
          webDomain: "https://deafcs.net",
          apiDomain: "https://api.deafcs.net",
        }),
      } as any,
    );
  });
  it.each(["declineDirect", "readDirect"])(
    "rejects foreign browser origins before %s writes",
    async (name) => {
      await expect(
        controller[name](
          {
            user: { steam_id: "1" },
            headers: { origin: "https://other.example" },
          } as any,
          "1:2",
        ),
      ).rejects.toThrow("request origin not allowed");
      expect(calls.decline).not.toHaveBeenCalled();
      expect(calls.markRead).not.toHaveBeenCalled();
    },
  );
  it.each(["https://deafcs.net", "https://api.deafcs.net"])(
    "allows authorized %s",
    async (origin) => {
      await controller.declineDirect(
        { user: { steam_id: "1" }, headers: { origin } } as any,
        "1:2",
      );
      expect(calls.decline).toHaveBeenCalledWith("1:2", { steam_id: "1" });
    },
  );
});
