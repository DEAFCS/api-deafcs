import fs from "fs";
import os from "os";
import path from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { HasuraService } from "../src/hasura/hasura.service";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS's matchmaking map pools must survive every migration run.
//
// 2026-07-29: a cleanup deleted legitimate _map_pool rows (b27cb746,
// reverted in acef2b49). 2026-10-16: a build changed every SQL digest, the
// init re-ran enums/maps.sql, and it disabled the customized Competitive,
// Wingman and Duel seed pools and created upstream ones in their place.
//
// Real PostgreSQL with every migration, enum, function, view and trigger,
// initialised by the real HasuraService.setup() as production's init is.
const MAPS_SQL = path.resolve("hasura/enums/maps.sql");

describe("map pool protection (SQL)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let hasura: HasuraService;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MapPoolProtection");
    postgres = db.postgres;
    hasura = db.hasura;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  type Snapshot = {
    maps: Array<string>;
    pools: Array<string>;
    links: Array<string>;
    setting: string | null;
  };

  // The three tables a re-run must leave alone, as comparable rows.
  async function snapshot(): Promise<Snapshot> {
    const maps = await postgres.query<Array<{ row: string }>>(
      `SELECT concat_ws('|', id, name, type, active_pool, enabled, workshop_map_id, label) AS row
         FROM maps ORDER BY id`,
    );
    const pools = await postgres.query<Array<{ row: string }>>(
      "SELECT concat_ws('|', id, type, enabled, seed) AS row FROM map_pools ORDER BY id",
    );
    const links = await postgres.query<Array<{ row: string }>>(
      "SELECT concat_ws('|', map_pool_id, map_id) AS row FROM _map_pool ORDER BY 1",
    );
    const [setting] = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM settings WHERE name = 'update_map_pools'",
    );
    return {
      maps: maps.map((r) => r.row),
      pools: pools.map((r) => r.row),
      links: links.map((r) => r.row),
      setting: setting?.value ?? null,
    };
  }

  async function seedPool(type: string) {
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = $1 AND seed AND enabled",
      [type],
    );
    return pool.id;
  }

  async function poolMaps(poolId: string) {
    const rows = await postgres.query<Array<{ name: string }>>(
      `SELECT m.name FROM _map_pool l JOIN maps m ON m.id = l.map_id
        WHERE l.map_pool_id = $1 ORDER BY m.name`,
      [poolId],
    );
    return rows.map((r) => r.name);
  }

  // The live pool matchmaking uses: createMatchBasedOnType picks the enabled
  // pool of the type (669754fc).
  async function matchmakingPool(type: string) {
    const rows = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM map_pools WHERE type = $1 AND enabled = true",
      [type],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id;
  }

  async function setPool(poolId: string, type: string, names: Array<string>) {
    await postgres.query("DELETE FROM _map_pool WHERE map_pool_id = $1", [
      poolId,
    ]);
    await postgres.query(
      `INSERT INTO _map_pool (map_pool_id, map_id)
       SELECT $1, id FROM maps WHERE type = $2 AND name = ANY($3::text[])`,
      [poolId, type, names],
    );
  }

  // Forces maps.sql to run again, the way a changed digest does.
  async function rerunMapsSql(lineEnding: "\n" | "\r\n" = "\n") {
    const sql = fs
      .readFileSync(MAPS_SQL, "utf8")
      .split("\r\n")
      .join("\n")
      .split("\n")
      .join(lineEnding);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maps-sql-"));
    const file = path.join(dir, "maps.sql");
    fs.writeFileSync(file, sql);
    try {
      await hasura.apply(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Forgets every stored digest, so setup() re-runs every SQL file.
  async function forgetAllDigests() {
    await postgres.query("DELETE FROM migration_hashes.hashes");
  }

  describe("a fresh installation", () => {
    it("creates and fills one enabled seed pool per type, with auto-update off", async () => {
      for (const type of ["Competitive", "Wingman", "Duel"]) {
        const pool = await seedPool(type);
        const expected = await postgres.query<Array<{ name: string }>>(
          "SELECT name FROM maps WHERE type = $1 AND active_pool ORDER BY name",
          [type],
        );
        expect(await poolMaps(pool)).toEqual(expected.map((r) => r.name));
        expect(expected.length).toBeGreaterThan(0);
      }
      expect((await snapshot()).setting).toBe("false");
    });

    it("leaves a fresh installation as it is when run again", async () => {
      const before = await snapshot();
      await rerunMapsSql();
      await rerunMapsSql("\r\n");
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("DEAFCS's customized pools", () => {
    let customized: Snapshot;
    let competitive: string;
    let wingman: string;
    let duel: string;

    beforeAll(async () => {
      competitive = await seedPool("Competitive");
      wingman = await seedPool("Wingman");
      duel = await seedPool("Duel");

      // A DEAFCS-only workshop map, the only map of the Duel pool.
      await postgres.query(
        `INSERT INTO maps (name, type, active_pool, workshop_map_id, label)
         VALUES ('3070290869', 'Duel', false, '3070290869', 'Mini Dust 2')
         ON CONFLICT (name, type) DO NOTHING`,
      );
      await setPool(duel, "Duel", ["3070290869"]);
      await setPool(competitive, "Competitive", [
        "de_ancient",
        "de_anubis",
        "de_cache",
        "de_dust2",
        "de_inferno",
        "de_mirage",
        "de_nuke",
      ]);
      await setPool(wingman, "Wingman", [
        "de_inferno",
        "de_nuke",
        "de_overpass",
      ]);
      // An admin's own active duty choices.
      await postgres.query(
        "UPDATE maps SET active_pool = NOT active_pool WHERE name IN ('de_vertigo', 'de_overpass') AND type IN ('Wingman', 'Duel')",
      );
      // A tournament/custom pool.
      const [custom] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO map_pools (type, enabled, seed) VALUES ('Custom', true, false) RETURNING id",
      );
      await postgres.query(
        `INSERT INTO _map_pool (map_pool_id, map_id)
         SELECT $1, id FROM maps WHERE type = 'Competitive' AND name IN ('de_train', 'de_overpass')`,
        [custom.id],
      );

      customized = await snapshot();
    });

    it("keeps maps, pools, memberships and flags when maps.sql re-runs (LF and CRLF)", async () => {
      await rerunMapsSql();
      expect(await snapshot()).toEqual(customized);
      await rerunMapsSql("\r\n");
      await rerunMapsSql("\r\n");
      expect(await snapshot()).toEqual(customized);
    });

    it("keeps them through a full re-initialisation that re-runs every SQL file", async () => {
      await forgetAllDigests();
      await hasura.setup();
      expect(await snapshot()).toEqual(customized);
      await hasura.setup();
      expect(await snapshot()).toEqual(customized);
    });

    it("keeps Mini Dust 2 as the Duel pool and the same live pool for every mode", async () => {
      expect(await matchmakingPool("Competitive")).toBe(competitive);
      expect(await matchmakingPool("Wingman")).toBe(wingman);
      expect(await matchmakingPool("Duel")).toBe(duel);
      expect(await poolMaps(duel)).toEqual(["3070290869"]);
      expect(await poolMaps(competitive)).toHaveLength(7);
      expect(await poolMaps(wingman)).toEqual([
        "de_inferno",
        "de_nuke",
        "de_overpass",
      ]);
    });

    it("an upgrade that brings a new seed map changes nothing while auto-update is off", async () => {
      // As if this map were new in the release.
      await postgres.query(
        "DELETE FROM maps WHERE name = 'de_thera' AND type = 'Competitive' AND id NOT IN (SELECT map_id FROM _map_pool)",
      );
      const before = await snapshot();
      await rerunMapsSql();
      expect(await snapshot()).toEqual(before);
      customized = before;
    });

    it("an admin's explicit setting is never overwritten", async () => {
      await postgres.query(
        "UPDATE settings SET value = 'false' WHERE name = 'update_map_pools'",
      );
      await rerunMapsSql();
      expect((await snapshot()).setting).toBe("false");
    });

    // Last: it changes the pools on purpose.
    it("turning Automatic Update Map Pools on restores upstream syncing, deleting nothing", async () => {
      const before = await snapshot();
      await postgres.query(
        "UPDATE settings SET value = 'true' WHERE name = 'update_map_pools'",
      );
      await rerunMapsSql();
      const after = await snapshot();

      // New seed maps arrive, and the live pool is synced to active duty
      // (the upstream behavior).
      const [thera] = await postgres.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM maps WHERE name = 'de_thera' AND type = 'Competitive'",
      );
      expect(thera.count).toBe(1);
      const active = await postgres.query<Array<{ name: string }>>(
        "SELECT name FROM maps WHERE type = 'Competitive' AND active_pool ORDER BY name",
      );
      expect(await poolMaps(await matchmakingPool("Competitive"))).toEqual(
        active.map((r) => r.name),
      );
      // Pools are only ever added or disabled, memberships only added.
      for (const pool of before.pools) {
        const id = pool.split("|")[0];
        expect(after.pools.some((p) => p.startsWith(id + "|"))).toBe(true);
      }
      for (const link of before.links) {
        expect(after.links).toContain(link);
      }
    });
  });

  describe("migration digests", () => {
    it("treat CRLF and LF as the same file", () => {
      const lf = "select 1;\nselect 2;\n";
      expect(hasura.calcSqlDigest(lf.split("\n").join("\r\n"))).toBe(
        hasura.calcSqlDigest(lf),
      );
      expect(hasura.calcSqlDigest(lf)).not.toBe(
        hasura.calcSqlDigest("select 1;\nselect 3;\n"),
      );
    });

    it("do not re-run a file whose only change is its line endings", async () => {
      await postgres.query(
        "CREATE TABLE IF NOT EXISTS public.digest_probe (n int)",
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"));
      const file = path.join(dir, "probe.sql");
      const sql = "insert into public.digest_probe values (1);\nselect 1;\n";
      try {
        fs.writeFileSync(file, sql);
        await hasura.apply(file);
        fs.writeFileSync(file, sql.split("\n").join("\r\n"));
        await hasura.apply(file);
        const [{ count }] = await postgres.query<Array<{ count: number }>>(
          "SELECT count(*)::int AS count FROM public.digest_probe",
        );
        expect(count).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await postgres.query("DROP TABLE public.digest_probe");
      }
    });
  });
});
