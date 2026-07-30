import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

const VERSION = "1873000000700";

describe("awards Phase A migration upgrade compatibility", () => {
  let db: SqlTestDb;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("AwardsMigrationUpgradeTest", {
      version: VERSION,
      prepare: async (postgres) => {
        // Reproduce the production collision before 0700: the legacy column
        // and an earlier deployment's authoritative column both exist.
        await postgres.query(
          `ALTER TABLE public.tournaments
             ADD COLUMN awards_enabled boolean NOT NULL DEFAULT false`,
        );
      },
    });
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("preserves the existing awards_enabled definition", async () => {
    const [row] = await db.postgres.query<Array<{ column_default: string }>>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tournaments'
          AND column_name = 'awards_enabled'`,
    );
    expect(row.column_default).toBe("false");
  });

  it("retains both synchronized compatibility columns", async () => {
    const rows = await db.postgres.query<Array<{ column_name: string }>>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tournaments'
          AND column_name IN ('awards_enabled', 'trophies_enabled')
        ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      "awards_enabled",
      "trophies_enabled",
    ]);
  });

  it("records the migration exactly once", async () => {
    const [{ count }] = await db.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM hdb_catalog.schema_migrations
        WHERE version = ${VERSION}`,
    );
    expect(count).toBe("1");
  });
});
