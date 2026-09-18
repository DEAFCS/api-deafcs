import fs from "fs";
import path from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

describe("website restriction migration and direct Hasura enforcement", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("WebsiteRestrictionTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM player_blocks");
    await postgres.query("DELETE FROM friends");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  it("installs the distinct sanction and blocks authenticated writes at execution time", async () => {
    const administrator = await fx.player("Administrator");
    const restricted = await fx.player("Restricted");
    const other = await fx.player("Other");

    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_restriction', 'abuse')`,
      [restricted, administrator],
    );

    await expect(
      runAsUser(postgres, restricted, "verified_user", (query) =>
        query(
          `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
           VALUES ($1, $2, 'Pending')`,
          [restricted, other],
        ),
      ),
    ).rejects.toThrow("restricted to read-only access");

    await expect(
      runAsUser(postgres, restricted, "verified_user", (query) =>
        query(
          `INSERT INTO support_requests
             (player_steam_id, category, subject, initial_message, status)
           VALUES ($1, 'general_support', 'appeal', 'internal appeal', 'open')`,
          [restricted],
        ),
      ),
    ).rejects.toThrow("restricted to read-only access");
  });

  it("expires automatically and leaves existing friendships and blocks intact", async () => {
    const administrator = await fx.player("Administrator");
    const restricted = await fx.player("Restricted");
    const friend = await fx.player("Existing Friend");
    const blockedBy = await fx.player("Existing Blocker");
    const newContact = await fx.player("New Contact");

    await postgres.query(
      `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
       VALUES ($1, $2, 'Accepted')`,
      [restricted, friend],
    );
    await postgres.query(
      `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
       VALUES ($1, $2)`,
      [blockedBy, restricted],
    );
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason, remove_sanction_date)
       VALUES ($1, $2, 'website_restriction', 'temporary', now() - interval '1 minute')`,
      [restricted, administrator],
    );

    await expect(
      runAsUser(postgres, restricted, "verified_user", (query) =>
        query(
          `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
           VALUES ($1, $2, 'Pending')
           ON CONFLICT (player_steam_id, other_player_steam_id)
           DO UPDATE SET status = EXCLUDED.status`,
          [restricted, newContact],
        ),
      ),
    ).resolves.toBeDefined();

    const [counts] = await postgres.query<
      Array<{ friendships: string; blocks: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM friends) AS friendships,
         (SELECT count(*)::text FROM player_blocks) AS blocks`,
    );
    expect(counts).toEqual({ friendships: "2", blocks: "1" });
  });

  it("prevents duplicate active restrictions but keeps Ban independent", async () => {
    const administrator = await fx.player("Administrator");
    const restricted = await fx.player("Restricted");

    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'ban', 'cheating'),
              ($1, $2, 'website_restriction', 'cheating')`,
      [restricted, administrator],
    );
    await expect(
      postgres.query(
        `INSERT INTO player_sanctions
           (player_steam_id, sanctioned_by_steam_id, type, reason)
         VALUES ($1, $2, 'website_restriction', 'duplicate')`,
        [restricted, administrator],
      ),
    ).rejects.toThrow("already has an active website restriction");

    await postgres.query(
      `UPDATE player_sanctions
          SET deleted_at = now(), revoked_by_steam_id = $2
        WHERE player_steam_id = $1 AND type = 'ban'`,
      [restricted, administrator],
    );
    const [state] = await postgres.query<
      Array<{ ban_active: boolean; restriction_active: boolean }>
    >(
      `SELECT
         EXISTS (SELECT 1 FROM player_sanctions WHERE player_steam_id = $1 AND type = 'ban' AND deleted_at IS NULL) AS ban_active,
         public.is_website_restricted($1) AS restriction_active`,
      [restricted],
    );
    expect(state).toEqual({ ban_active: false, restriction_active: true });
  });

  it("blocks a restricted moderator from exercising moderation power via direct writes", async () => {
    const administrator = await fx.player("Administrator");
    const restrictedModerator = await fx.player("Restricted Moderator");
    const otherPlayer = await fx.player("Sanction Target");

    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_restriction', 'abused moderation power')`,
      [restrictedModerator, administrator],
    );
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'mute', 'toxicity')`,
      [otherPlayer, administrator],
    );

    await expect(
      runAsUser(postgres, restrictedModerator, "moderator", (query) =>
        query(
          `UPDATE player_sanctions
              SET remove_sanction_date = now()
            WHERE player_steam_id = $1 AND type = 'mute'`,
          [otherPlayer],
        ),
      ),
    ).rejects.toThrow("restricted to read-only access");

    await expect(
      runAsUser(postgres, restrictedModerator, "match_organizer", (query) =>
        query(
          `INSERT INTO seasons (number, starts_at) VALUES (999, now())`,
        ),
      ),
    ).rejects.toThrow("restricted to read-only access");
  });

  it("rolls back cleanly", async () => {
    const down = fs.readFileSync(
      path.resolve(
        "hasura/migrations/default/1878000013000_website_restriction/down.sql",
      ),
      "utf8",
    );
    await postgres.query(down);

    const [state] = await postgres.query<
      Array<{ sanction_type: string | null; guard_function: string | null }>
    >(
      `SELECT
         (SELECT value FROM e_sanction_types WHERE value = 'website_restriction') AS sanction_type,
         to_regprocedure('public.enforce_website_restriction_write()')::text AS guard_function`,
    );
    expect(state).toEqual({ sanction_type: null, guard_function: null });
  });
});
