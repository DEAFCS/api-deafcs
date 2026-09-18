import fs from "fs";
import path from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("website chat moderation migration", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("WebsiteChatModerationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199962000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM chat_message_deletions");
    await postgres.query("DELETE FROM announcements");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  it("installs the separate sanction type and private deletion audit table", async () => {
    const [state] = await postgres.query<
      Array<{ sanction_type: string | null; audit_table: string | null }>
    >(
      `SELECT
         (SELECT value FROM e_sanction_types WHERE value = 'website_chat_mute') AS sanction_type,
         to_regclass('public.chat_message_deletions')::text AS audit_table`,
    );
    expect(state).toEqual({
      sanction_type: "website_chat_mute",
      audit_table: "chat_message_deletions",
    });
  });

  it("requires a reason and prevents duplicate active website mutes", async () => {
    const administrator = await fx.player("Moderator");
    const player = await fx.player("MutedPlayer");

    await expect(
      postgres.query(
        `INSERT INTO player_sanctions
           (player_steam_id, sanctioned_by_steam_id, type, reason)
         VALUES ($1, $2, 'website_chat_mute', '   ')`,
        [player, administrator],
      ),
    ).rejects.toThrow("reason is required");

    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason, remove_sanction_date)
       VALUES ($1, $2, 'website_chat_mute', 'spam', now() + interval '24 hours')`,
      [player, administrator],
    );

    await expect(
      postgres.query(
        `INSERT INTO player_sanctions
           (player_steam_id, sanctioned_by_steam_id, type, reason)
         VALUES ($1, $2, 'website_chat_mute', 'duplicate')`,
        [player, administrator],
      ),
    ).rejects.toThrow("already has an active website chat mute");
  });

  it("allows a replacement after expiry and records early revocation", async () => {
    const administrator = await fx.player("Moderator");
    const player = await fx.player("MutedPlayer");

    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason, remove_sanction_date)
       VALUES ($1, $2, 'website_chat_mute', 'expired', now() - interval '1 minute')`,
      [player, administrator],
    );
    const [active] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_chat_mute', 'replacement')
       RETURNING id`,
      [player, administrator],
    );
    await postgres.query(
      `UPDATE player_sanctions
          SET deleted_at = now(), revoked_by_steam_id = $2
        WHERE id = $1`,
      [active.id, administrator],
    );

    const [revoked] = await postgres.query<
      Array<{ deleted: boolean; revoked_by_steam_id: string }>
    >(
      `SELECT deleted_at IS NOT NULL AS deleted, revoked_by_steam_id
         FROM player_sanctions WHERE id = $1`,
      [active.id],
    );
    expect(revoked).toEqual({
      deleted: true,
      revoked_by_steam_id: administrator,
    });
  });

  it("serializes concurrent inserts so only one active mute is created", async () => {
    const administrator = await fx.player("Moderator");
    const player = await fx.player("MutedPlayer");
    const pool = (
      postgres as unknown as {
        pool: {
          connect(): Promise<{
            query(sql: string, params?: unknown[]): Promise<unknown>;
            release(): void;
          }>;
        };
      }
    ).pool;
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(
        `INSERT INTO player_sanctions
           (player_steam_id, sanctioned_by_steam_id, type, reason)
         VALUES ($1, $2, 'website_chat_mute', 'first')`,
        [player, administrator],
      );
      const competing = second.query(
        `INSERT INTO player_sanctions
           (player_steam_id, sanctioned_by_steam_id, type, reason)
         VALUES ($1, $2, 'website_chat_mute', 'second')`,
        [player, administrator],
      );
      await first.query("COMMIT");
      await expect(competing).rejects.toThrow(
        "already has an active website chat mute",
      );
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }

    await expect(
      postgres.query(
        `SELECT 1 FROM player_sanctions
          WHERE player_steam_id = $1 AND type = 'website_chat_mute'
            AND deleted_at IS NULL`,
        [player],
      ),
    ).resolves.toHaveLength(1);
  });

  it("rolls the migration back cleanly in the disposable database", async () => {
    const down = fs.readFileSync(
      path.resolve(
        "hasura/migrations/default/1878000011000_website_chat_moderation/down.sql",
      ),
      "utf8",
    );
    await postgres.query(down);
    const [state] = await postgres.query<
      Array<{ audit_table: string | null; guard_function: string | null }>
    >(
      `SELECT
         to_regclass('public.chat_message_deletions')::text AS audit_table,
         to_regprocedure('public.guard_website_chat_mute()')::text AS guard_function`,
    );
    expect(state).toEqual({ audit_table: null, guard_function: null });
  });
});
