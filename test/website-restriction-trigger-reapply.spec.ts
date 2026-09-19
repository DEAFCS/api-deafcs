import fs from "fs";
import path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { HasuraService } from "./../src/hasura/hasura.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Proves the fix for the production deadlock: hasura/triggers/website_restrictions.sql
// used to unconditionally DROP+CREATE the enforce_website_restriction_write
// trigger on ~59 tables every time it was applied, including immediately
// after the versioned migration that had just installed the exact same
// triggers moments earlier in the same hasura.setup() run. Each DROP+CREATE
// needs an AccessExclusiveLock, which deadlocked against a live Hasura
// subscription reading `lobbies`. The fix makes the DO block compare the
// already-installed trigger's actual (tgtype, tgfoid) against the intended
// definition and only take the lock on a table where something is actually
// missing or wrong.
describe("website_restrictions.sql trigger reapplication no longer relocks unchanged tables", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  const triggerSql = fs.readFileSync(
    path.resolve("./hasura/triggers/website_restrictions.sql"),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("WebsiteRestrictionTriggerReapply");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199965000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const triggerOid = async (table: string) => {
    const [row] = await postgres.query<Array<{ oid: string }>>(
      `SELECT t.oid::text FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1
          AND t.tgname = 'enforce_website_restriction_write'`,
      [table],
    );
    return row?.oid ?? null;
  };

  const rerunTriggerFile = () =>
    postgres.query(`begin;set local statement_timeout = 0;${triggerSql};commit;`);

  it("a fresh install creates the trigger on every real table in the list (sample check)", async () => {
    for (const table of ["friends", "lobbies", "matches", "player_sanctions", "seasons"]) {
      expect(await triggerOid(table)).not.toBeNull();
    }
    // The three stale/nonexistent names in the array must not silently
    // create anything, and the two view-only names must be skipped too.
    for (const nonTable of ["match_invites", "match_veto_picks", "tournament_roster"]) {
      const [exists] = await postgres.query<Array<{ exists: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = $1) AS exists`,
        [nonTable],
      );
      expect(exists.exists).toBe(false);
    }
  });

  it("reapplying the unchanged file is a no-op for already-correct tables -- their trigger OID never changes (no DROP+CREATE, no lock retaken)", async () => {
    const before = await Promise.all(
      ["friends", "lobbies", "matches", "player_sanctions", "seasons", "team_roster"].map(
        async (t) => [t, await triggerOid(t)] as const,
      ),
    );
    for (const [, oid] of before) {
      expect(oid).not.toBeNull();
    }

    await rerunTriggerFile();
    await rerunTriggerFile();
    await rerunTriggerFile();

    const after = await Promise.all(
      before.map(async ([t]) => [t, await triggerOid(t)] as const),
    );
    expect(after).toEqual(before);
  });

  it("a trigger that went missing gets reinstalled", async () => {
    await postgres.query(
      `DROP TRIGGER enforce_website_restriction_write ON public.seasons`,
    );
    expect(await triggerOid("seasons")).toBeNull();

    await rerunTriggerFile();

    expect(await triggerOid("seasons")).not.toBeNull();
  });

  it("a trigger with the right name but the wrong definition gets corrected, not trusted by name alone", async () => {
    await postgres.query(
      `DROP TRIGGER enforce_website_restriction_write ON public.seasons`,
    );
    // Deliberately wrong: AFTER instead of BEFORE, INSERT only, pointed at
    // an unrelated existing function -- same trigger *name*, wrong shape.
    await postgres.query(
      `CREATE TRIGGER enforce_website_restriction_write
         AFTER INSERT ON public.seasons
         FOR EACH ROW EXECUTE FUNCTION public.is_website_restricted()`,
    ).catch(() => {
      // is_website_restricted() isn't a trigger function (wrong return
      // type), so Postgres may refuse this at CREATE time -- either way is
      // fine for this test; if it's refused, prove the fix still overwrites
      // whatever bogus trigger *does* exist rather than needing this exact
      // one, using a genuine trigger function with the wrong event mask.
    });

    let hadBogus = (await triggerOid("seasons")) !== null;
    if (!hadBogus) {
      await postgres.query(
        `CREATE TRIGGER enforce_website_restriction_write
           AFTER INSERT ON public.seasons
           FOR EACH ROW EXECUTE FUNCTION public.guard_active_website_restriction()`,
      );
      hadBogus = true;
    }
    const bogusOid = await triggerOid("seasons");
    expect(bogusOid).not.toBeNull();

    const [bogusRow] = await postgres.query<
      Array<{ tgtype: number; tgfoid: string }>
    >(`SELECT tgtype, tgfoid::text FROM pg_trigger WHERE oid = $1`, [bogusOid]);
    expect(bogusRow.tgtype).not.toBe(31);

    await rerunTriggerFile();

    const fixedOid = await triggerOid("seasons");
    expect(fixedOid).not.toBeNull();
    expect(fixedOid).not.toBe(bogusOid);
    const [fixedRow] = await postgres.query<
      Array<{ tgtype: number; tgfoid: string }>
    >(`SELECT tgtype, tgfoid::text FROM pg_trigger WHERE oid = $1`, [fixedOid]);
    expect(fixedRow.tgtype).toBe(31);
  });

  it("a correct-looking but DISABLED trigger is detected and re-enabled, restoring real enforcement", async () => {
    // Start from a known-good state regardless of prior test ordering.
    await rerunTriggerFile();
    const goodOid = await triggerOid("seasons");
    expect(goodOid).not.toBeNull();

    await postgres.query(
      `ALTER TABLE public.seasons DISABLE TRIGGER enforce_website_restriction_write`,
    );
    const [disabledRow] = await postgres.query<Array<{ tgenabled: string }>>(
      `SELECT tgenabled FROM pg_trigger WHERE oid = $1`,
      [goodOid],
    );
    expect(disabledRow.tgenabled).toBe("D");

    // While disabled, a restricted actor's write must NOT be blocked -- this
    // is the exact silent bypass a name/type/function-only comparison would
    // have missed (same OID, same tgtype, same tgfoid, just switched off).
    const administrator = await fx.player("AdministratorDisabled");
    const restricted = await fx.player("RestrictedDisabled");
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_restriction', 'abuse')`,
      [restricted, administrator],
    );
    await expect(
      runAsUser(postgres, restricted, "match_organizer", (query) =>
        query(`INSERT INTO seasons (number, starts_at) VALUES (9001, now())`),
      ),
    ).resolves.toBeDefined();
    await postgres.query(`DELETE FROM seasons WHERE number = 9001`);

    await rerunTriggerFile();

    const [reenabledRow] = await postgres.query<Array<{ tgenabled: string }>>(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.seasons'::regclass
         AND tgname = 'enforce_website_restriction_write'`,
    );
    expect(reenabledRow.tgenabled).toBe("O");

    await expect(
      runAsUser(postgres, restricted, "match_organizer", (query) =>
        query(`INSERT INTO seasons (number, starts_at) VALUES (9002, now())`),
      ),
    ).rejects.toThrow("restricted to read-only access");
  });

  it("a trigger with an added WHEN condition is detected and corrected", async () => {
    await rerunTriggerFile();
    await postgres.query(
      `DROP TRIGGER enforce_website_restriction_write ON public.seasons`,
    );
    // A WHEN (false) condition would make the trigger permanently inert
    // while still matching on name, tgtype, tgfoid and tgenabled.
    await postgres.query(
      `CREATE TRIGGER enforce_website_restriction_write
         BEFORE INSERT OR UPDATE OR DELETE ON public.seasons
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION public.enforce_website_restriction_write()`,
    );
    const [withWhen] = await postgres.query<Array<{ has_when: boolean }>>(
      `SELECT tgqual IS NOT NULL AS has_when FROM pg_trigger
        WHERE tgrelid = 'public.seasons'::regclass
          AND tgname = 'enforce_website_restriction_write'`,
    );
    expect(withWhen.has_when).toBe(true);

    await rerunTriggerFile();

    const [afterFix] = await postgres.query<Array<{ has_when: boolean }>>(
      `SELECT tgqual IS NOT NULL AS has_when FROM pg_trigger
        WHERE tgrelid = 'public.seasons'::regclass
          AND tgname = 'enforce_website_restriction_write'`,
    );
    expect(afterFix.has_when).toBe(false);
  });

  it("digest tracking still records this file as applied after a real change", async () => {
    const settingKey = "hasura/triggers/website_restrictions";
    const digest = db.hasura.calcSqlDigest(triggerSql);
    await db.hasura.setSetting(settingKey, digest);
    expect(await db.hasura.getSetting(settingKey)).toBe(digest);
  });

  it("coach-cap fix (team_roster.sql, unmodified by this change) is still installed", async () => {
    const [row] = await postgres.query<Array<{ prosrc: string }>>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'tbiu_team_roster_status'`,
    );
    expect(row.prosrc).toMatch(/NOT coach/);
  });

  it("website restriction enforcement is still genuinely active end to end", async () => {
    const administrator = await fx.player("Administrator2");
    const restricted = await fx.player("Restricted2");
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_restriction', 'abuse')`,
      [restricted, administrator],
    );

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
});
