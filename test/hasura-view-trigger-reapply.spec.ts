import fs from "fs";
import path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { HasuraService } from "./../src/hasura/hasura.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Reproduces the 2026-10-01 production failure: setup() reapplied
// hasura/views/v_pool_maps.sql because its recorded digest was stale. That
// file DROPs and recreates the view, which silently drops the three INSTEAD OF
// triggers defined in hasura/triggers/v_pool_maps.sql. The trigger file's own
// digest was unchanged, so apply() skipped it and every custom map pool insert
// (tournament and match creation) failed with
// `cannot insert into view "v_pool_maps"`. setup() must restore the triggers
// even though the trigger file's digest still says "applied".
describe("setup() restores view triggers dropped by a view reapply", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let hasura: HasuraService;

  const VIEW_FILE = path.resolve("./hasura/views/v_pool_maps.sql");
  const TRIGGER_FILE = path.resolve("./hasura/triggers/v_pool_maps.sql");
  // Same key HasuraService.apply() records the digest under.
  const settingFor = (file: string) =>
    path.relative(process.cwd(), file.replace(".sql", ""));

  beforeAll(async () => {
    db = await bootMigratedDb("HasuraViewTriggerReapply");
    postgres = db.postgres;
    hasura = db.hasura;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const viewTriggers = async () =>
    (
      await postgres.query<Array<{ tgname: string; fn: string }>>(
        `SELECT t.tgname, p.proname AS fn
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = 'public.v_pool_maps'::regclass
            AND NOT t.tgisinternal
          ORDER BY t.tgname`,
      )
    ).map(({ tgname, fn }) => `${tgname}->${fn}`);

  const EXPECTED = [
    "td_v_pool_maps->td_v_pool_maps",
    "ti_v_pool_maps->ti_v_pool_maps",
    "tu_v_pool_maps->tu_v_pool_maps",
  ];

  // The same nested insert Hasura issues for options.map_pool.maps.
  const insertCustomPool = async () => {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.map_pools (type, seed)
       SELECT value, false FROM public.e_map_pool_types LIMIT 1
       RETURNING id`,
    );
    const maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM public.maps ORDER BY name LIMIT 2",
    );
    expect(maps).toHaveLength(2);
    for (const map of maps) {
      await postgres.query(
        "INSERT INTO public.v_pool_maps (id, map_pool_id) VALUES ($1, $2)",
        [map.id, pool.id],
      );
    }
    const [{ count }] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM public._map_pool WHERE map_pool_id = $1",
      [pool.id],
    );
    return count;
  };

  it("a fresh setup attaches the three INSTEAD OF triggers and records the trigger file digest", async () => {
    expect(await viewTriggers()).toEqual(EXPECTED);
    expect(await hasura.getSetting(settingFor(TRIGGER_FILE))).toBe(
      hasura.calcSqlDigest(fs.readFileSync(TRIGGER_FILE, "utf8")),
    );
    expect(await insertCustomPool()).toBe(2);
  });

  it("recreating the view drops its triggers and breaks the insert (the production failure)", async () => {
    await postgres.query(fs.readFileSync(VIEW_FILE, "utf8"));

    expect(await viewTriggers()).toEqual([]);
    await expect(insertCustomPool()).rejects.toThrow(
      'cannot insert into view "v_pool_maps"',
    );
  });

  it("setup() with a stale view digest and an unchanged trigger digest restores the triggers", async () => {
    // Recreate the trigger-less state through setup() itself, exactly as on
    // 2026-10-01: the view digest is stale, the trigger digest is current.
    const triggerDigest = await hasura.getSetting(settingFor(TRIGGER_FILE));
    await hasura.setSetting(settingFor(VIEW_FILE), "stale-digest");

    await hasura.setup();

    expect(await viewTriggers()).toEqual(EXPECTED);
    expect(await hasura.getSetting(settingFor(TRIGGER_FILE))).toBe(
      triggerDigest,
    );
    const [ti] = await postgres.query<Array<{ def: string }>>(
      "SELECT pg_get_functiondef('public.ti_v_pool_maps'::regproc) AS def",
    );
    expect(ti.def).toContain("INSERT INTO _map_pool (map_id, map_pool_id)");
    expect(await insertCustomPool()).toBe(2);
  });

  it("a setup() with nothing changed reapplies no SQL file", async () => {
    const query = jest.spyOn(postgres, "query");
    try {
      await hasura.setup();
      const applied = query.mock.calls.filter(([sql]) =>
        sql.startsWith("begin;set local statement_timeout = 0;"),
      );
      expect(applied).toEqual([]);
    } finally {
      query.mockRestore();
    }
  });

  it("parses statically declared triggers and skips dynamic format() ones", () => {
    expect(
      hasura.declaredTriggers(fs.readFileSync(TRIGGER_FILE, "utf8")),
    ).toEqual([
      { name: "ti_v_pool_maps", schema: "public", table: "v_pool_maps" },
      { name: "tu_v_pool_maps", schema: "public", table: "v_pool_maps" },
      { name: "td_v_pool_maps", schema: "public", table: "v_pool_maps" },
    ]);
    expect(
      hasura.declaredTriggers(
        fs.readFileSync(
          path.resolve("./hasura/triggers/website_restrictions.sql"),
          "utf8",
        ),
      ),
    ).toEqual([
      {
        name: "guard_active_website_restriction",
        schema: "public",
        table: "player_sanctions",
      },
    ]);
    expect(
      hasura.declaredTriggers(
        `-- CREATE TRIGGER commented ON public.nope
         CREATE TRIGGER "Quoted" AFTER UPDATE OF a, b ON Other.Thing FOR EACH ROW EXECUTE FUNCTION f();`,
      ),
    ).toEqual([{ name: "Quoted", schema: "other", table: "thing" }]);
  });
});
