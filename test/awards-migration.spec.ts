import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

const VERSION = "1873000000700";
const PLAYER_ID = "76561198000000001";
const TOURNAMENT_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_TEAM_ID = "22222222-2222-4222-8222-222222222222";
const TROPHY_ID = "33333333-3333-4333-8333-333333333333";
const CONFIG_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_TROPHY_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_CONFIG_ID = "66666666-6666-4666-8666-666666666666";

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

        await postgres.query(
          `INSERT INTO public.e_player_roles (value, description)
           VALUES ('user', 'User')
           ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.e_map_pool_types (value, description)
           VALUES ('Competitive', 'Competitive')
           ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.e_match_types (value, description)
           VALUES ('Competitive', 'Competitive')
           ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.e_tournament_status (value, description)
           VALUES ('Setup', 'Setup')
           ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.e_timeout_settings (value, description)
           VALUES ('CoachAndPlayers', 'Coach and players')
           ON CONFLICT (value) DO NOTHING`,
        );
        await postgres.query(
          `INSERT INTO public.players (steam_id, name)
           VALUES (${PLAYER_ID}, 'Migration trophy player')`,
        );
        const [{ id: mapPoolId }] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO public.map_pools (type)
           VALUES ('Competitive')
           RETURNING id`,
        );
        const [{ id: matchOptionsId }] = await postgres.query<
          Array<{ id: string }>
        >(
          `INSERT INTO public.match_options (
             overtime, knife_round, mr, best_of, coaches,
             map_veto, map_pool_id, type
           )
           VALUES (true, true, 12, 1, false, false, $1, 'Competitive')
           RETURNING id`,
          [mapPoolId],
        );
        await postgres.query(
          `INSERT INTO public.tournaments (
             id, name, start, organizer_steam_id, match_options_id
           )
           VALUES ($1, 'Migration trophy cup', now(), $2, $3)`,
          [TOURNAMENT_ID, PLAYER_ID, matchOptionsId],
        );
        await postgres.query(
          `INSERT INTO public.tournament_teams (
             id, tournament_id, name, owner_steam_id
           )
           VALUES ($1, $2, 'Migration trophy team', $3)`,
          [TOURNAMENT_TEAM_ID, TOURNAMENT_ID, PLAYER_ID],
        );

        const trophyTable = (name: string) => `
          CREATE TABLE public.${name} (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
            tournament_team_id uuid NOT NULL REFERENCES public.tournament_teams(id) ON DELETE CASCADE,
            player_steam_id bigint REFERENCES public.players(steam_id) ON DELETE CASCADE,
            placement int NOT NULL CHECK (placement IN (0, 1, 2, 3)),
            placement_tier text GENERATED ALWAYS AS (
              CASE placement
                WHEN 0 THEN 'mvp'
                WHEN 1 THEN 'gold'
                WHEN 2 THEN 'silver'
                WHEN 3 THEN 'bronze'
              END
            ) STORED,
            manual boolean NOT NULL DEFAULT false,
            team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL DEFAULT now()
          )`;
        const configTable = (name: string) => `
          CREATE TABLE public.${name} (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
            placement int NOT NULL CHECK (placement IN (0, 1, 2, 3)),
            custom_name text,
            silhouette int CHECK (silhouette IS NULL OR silhouette BETWEEN 0 AND 4),
            image_url text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tournament_id, placement)
          )`;

        await postgres.query(trophyTable("award_recipients"));
        await postgres.query(configTable("tournament_awards"));

        await postgres.query(
          `INSERT INTO public.award_recipients (
             id, tournament_id, tournament_team_id, player_steam_id,
             placement, manual
           )
           VALUES ($1, $2, $3, $4, 2, true)`,
          [TARGET_TROPHY_ID, TOURNAMENT_ID, TOURNAMENT_TEAM_ID, PLAYER_ID],
        );
        await postgres.query(
          `INSERT INTO public.tournament_awards (
             id, tournament_id, placement, custom_name, silhouette, image_url
           )
           VALUES ($1, $2, 2, 'Existing runner-up', 3, 'legacy/runner-up.png')`,
          [TARGET_CONFIG_ID, TOURNAMENT_ID],
        );
        await postgres.query(
          `INSERT INTO public.tournament_trophies (
             id, tournament_id, tournament_team_id, player_steam_id,
             placement, manual
           )
           VALUES ($1, $2, $3, $4, 1, true)`,
          [TROPHY_ID, TOURNAMENT_ID, TOURNAMENT_TEAM_ID, PLAYER_ID],
        );
        await postgres.query(
          `INSERT INTO public.tournament_trophy_configs (
             id, tournament_id, placement, custom_name, silhouette, image_url
           )
           VALUES ($1, $2, 1, 'Legacy champion', 2, 'legacy/champion.png')`,
          [CONFIG_ID, TOURNAMENT_ID],
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

  it("preserves legacy trophy rows and relationships", async () => {
    const rows = await db.postgres.query<
      Array<{
        id: string;
        tournament_id: string;
        tournament_team_id: string;
        player_steam_id: string;
        placement: number;
      }>
    >(
      `SELECT id, tournament_id, tournament_team_id,
              player_steam_id::text, placement
         FROM public.tournament_trophies
        WHERE id = ANY($1::uuid[])
        ORDER BY placement`,
      [[TROPHY_ID, TARGET_TROPHY_ID]],
    );
    expect(rows).toEqual([
      {
        id: TROPHY_ID,
        tournament_id: TOURNAMENT_ID,
        tournament_team_id: TOURNAMENT_TEAM_ID,
        player_steam_id: PLAYER_ID,
        placement: 1,
      },
      {
        id: TARGET_TROPHY_ID,
        tournament_id: TOURNAMENT_ID,
        tournament_team_id: TOURNAMENT_TEAM_ID,
        player_steam_id: PLAYER_ID,
        placement: 2,
      },
    ]);
  });

  it("preserves legacy trophy configuration rows", async () => {
    const rows = await db.postgres.query<
      Array<{
        id: string;
        tournament_id: string;
        placement: number;
        custom_name: string;
        silhouette: number;
        image_url: string;
      }>
    >(
      `SELECT id, tournament_id, placement, custom_name, silhouette, image_url
         FROM public.tournament_trophy_configs
        WHERE id = ANY($1::uuid[])
        ORDER BY placement`,
      [[CONFIG_ID, TARGET_CONFIG_ID]],
    );
    expect(rows).toEqual([
      {
        id: CONFIG_ID,
        tournament_id: TOURNAMENT_ID,
        placement: 1,
        custom_name: "Legacy champion",
        silhouette: 2,
        image_url: "legacy/champion.png",
      },
      {
        id: TARGET_CONFIG_ID,
        tournament_id: TOURNAMENT_ID,
        placement: 2,
        custom_name: "Existing runner-up",
        silhouette: 3,
        image_url: "legacy/runner-up.png",
      },
    ]);
  });
});
