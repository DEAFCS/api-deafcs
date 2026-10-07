import fs from "fs";
import path from "path";
import {
  bootContainerAndMigrate,
  runAsUser,
  SqlTestDb,
} from "./utils/sql-test-db";

// teams.created_at feeds "Founded Mon YYYY". Nothing records when an existing
// team was created, so existing teams must stay NULL (never stamped with the
// migration's time), while every new team gets its real creation time.
const VERSION = "1889000000100";
const OWNER = "76561198000000101";
const LEGACY_OWNER = "76561198000000102";

describe("teams.created_at migration", () => {
  let db: SqlTestDb;
  let legacyTeamId: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TeamsCreatedAtMigration", {
      version: VERSION,
      prepare: async (postgres) => {
        // A team that exists before the column does.
        await postgres.query(
          `INSERT INTO public.e_player_roles (value, description)
           VALUES ('user', 'User') ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.players (steam_id, name)
           VALUES (${LEGACY_OWNER}, 'Legacy owner'), (${OWNER}, 'New owner')`,
        );
        const [{ id }] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO public.teams (name, short_name, owner_steam_id)
           VALUES ('Legacy Team', 'LEG', ${LEGACY_OWNER}) RETURNING id`,
        );
        legacyTeamId = id;
      },
    });
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("leaves a team that predates the column without a creation date", async () => {
    const [team] = await db.postgres.query<Array<{ created_at: string | null }>>(
      "SELECT created_at FROM teams WHERE id = $1",
      [legacyTeamId],
    );
    expect(team).toBeDefined();
    expect(team.created_at).toBeNull();
  });

  it("stamps a team created afterwards with its real creation time", async () => {
    const before = Date.now() - 5_000;
    const [team] = await runAsUser(db.postgres, OWNER, "admin", (query) =>
      query(
        `INSERT INTO teams (name, short_name, owner_steam_id)
         VALUES ('Fresh Team', 'FRE', $1) RETURNING id, created_at`,
        [OWNER],
      ),
    );
    const stamped = new Date(team.created_at).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("keeps the column nullable with a default for new rows only", async () => {
    const [column] = await db.postgres.query<
      Array<{ is_nullable: string; column_default: string | null; data_type: string }>
    >(
      `SELECT is_nullable, column_default, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'created_at'`,
    );
    expect(column.data_type).toBe("timestamp with time zone");
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default).toMatch(/now\(\)/i);
  });

  it("never backfills: the migration only adds the column and its default", () => {
    const up = fs
      .readFileSync(
        path.resolve("hasura/migrations/default/1889000000100_teams_created_at/up.sql"),
        "utf8",
      )
      // comments explain why; only statements count
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(up).not.toMatch(/\bUPDATE\b/i);
    expect(up).not.toMatch(/team_admin_audit|matches|tournament/i);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS created_at timestamptz;/);
    expect(up.indexOf("ADD COLUMN")).toBeLessThan(up.indexOf("SET DEFAULT now()"));
  });

  it("can be rolled back", () => {
    const down = fs.readFileSync(
      path.resolve("hasura/migrations/default/1889000000100_teams_created_at/down.sql"),
      "utf8",
    );
    expect(down).toMatch(/DROP COLUMN IF EXISTS created_at/);
  });
});
