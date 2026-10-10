import fs from "fs";
import path from "path";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// match_requested_organizer() (matches.requested_organizer) looks for an
// unread MatchSupport notification of one match. Without an index that was a
// parallel sequential scan of the whole notifications table on every call.
// This spec proves the partial index from migration 1890000000200 exists,
// matches the function's predicate (so the planner can use it), and that the
// function's answer is unchanged.
describe("notifications_match_support_unread_idx", () => {
  let db: SqlTestDb;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("NotificationsMatchSupportIndexTest");
    fx = new Fixtures(db.postgres, 76561199830000000n);
    await seedRegionWithServer(db.postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.postgres.query("DELETE FROM notifications");
  });

  async function notify(
    entityId: string,
    type: string,
    isRead: boolean,
  ): Promise<void> {
    await db.postgres.query(
      `INSERT INTO notifications (title, message, role, type, entity_id, is_read)
       VALUES ('t', 'm', 'administrator', $1, $2, $3)`,
      [type, entityId, isRead],
    );
  }

  async function requestedOrganizer(
    matchId: string,
    viewer: string,
  ): Promise<boolean | null> {
    const [row] = await db.postgres.query<Array<{ value: boolean | null }>>(
      `SELECT match_requested_organizer(m, json_build_object('x-hasura-user-id', $2::text)) AS value
       FROM matches m WHERE m.id = $1`,
      [matchId, viewer],
    );
    return row.value;
  }

  it("exists as a partial index on entity_id for unread MatchSupport rows", async () => {
    const [index] = await db.postgres.query<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'notifications'
         AND indexname = 'notifications_match_support_unread_idx'`,
    );
    expect(index?.indexdef).toContain("(entity_id)");
    expect(index?.indexdef).toContain("'MatchSupport'::text");
    expect(index?.indexdef).toMatch(/is_read = false/);
  });

  it("was built by the migration runner outside a transaction, valid and recorded", async () => {
    // CREATE INDEX CONCURRENTLY fails inside a transaction block, so this
    // only passes if the runner honoured the -- @disable-transaction marker.
    const [state] = await db.postgres.query<
      Array<{ valid: boolean; ready: boolean }>
    >(
      `SELECT i.indisvalid AS valid, i.indisready AS ready
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'notifications_match_support_unread_idx'`,
    );
    expect(state).toEqual({ valid: true, ready: true });

    const [migration] = await db.postgres.query<Array<{ dirty: boolean }>>(
      "SELECT dirty FROM hdb_catalog.schema_migrations WHERE version = 1890000000200",
    );
    expect(migration).toEqual({ dirty: false });
  });

  it("keeps the migration file to the marker plus one statement", () => {
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        "../hasura/migrations/default/1890000000200_notifications_match_support_unread_idx/up.sql",
      ),
      "utf8",
    );
    expect(sql.startsWith("-- @disable-transaction")).toBe(true);
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .filter((part) => part.trim().length > 0);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });

  it("is usable for the exact predicate match_requested_organizer runs", async () => {
    const plan = await db.postgres.transaction(async (client) => {
      // Tiny test tables make a sequential scan cheaper; switching it off
      // shows whether the index can serve the predicate at all.
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query(
        `EXPLAIN SELECT 1 FROM notifications
         WHERE entity_id = 'some-match-id'
           AND type = 'MatchSupport'
           AND is_read = false`,
      );
      return result.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("notifications_match_support_unread_idx");
  });

  it("keeps match_requested_organizer's answer unchanged", async () => {
    const { matchId } = await fx.bareMatch();
    const [match] = await db.postgres.query<Array<{ lineup_1_id: string }>>(
      "SELECT lineup_1_id FROM matches WHERE id = $1",
      [matchId],
    );
    const player = await fx.lineupPlayer(match.lineup_1_id);
    const outsider = await fx.player();
    const { matchId: otherMatchId } = await fx.bareMatch();

    // No support request yet.
    expect(await requestedOrganizer(matchId, player)).toBe(false);

    // A read request, another type, and another match's request don't count.
    await notify(matchId, "MatchSupport", true);
    await notify(matchId, "MatchStatusChange", false);
    await notify(otherMatchId, "MatchSupport", false);
    expect(await requestedOrganizer(matchId, player)).toBe(false);

    // An unread request for this match does, for someone in the lineup...
    await notify(matchId, "MatchSupport", false);
    expect(await requestedOrganizer(matchId, player)).toBe(true);
    // ...but not for a viewer who is neither organizer nor in the lineup.
    // The existing function returns NULL here, not false: for a match with
    // no organizer, is_match_organizer() yields NULL, and NULL OR false is
    // NULL. Unchanged by the index; Hasura serializes it as null (falsy).
    expect(await requestedOrganizer(matchId, outsider)).not.toBe(true);

    // Once read, it no longer counts.
    await db.postgres.query(
      "UPDATE notifications SET is_read = true WHERE entity_id = $1",
      [matchId],
    );
    expect(await requestedOrganizer(matchId, player)).toBe(false);
  });
});
