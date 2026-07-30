import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

const VERSION = "1873000000700";
const PLAYER_ID = "76561198000000001";
const TOURNAMENT_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_TEAM_ID = "22222222-2222-4222-8222-222222222222";
const TROPHY_ID = "33333333-3333-4333-8333-333333333333";
const CONFIG_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_TROPHY_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_CONFIG_ID = "66666666-6666-4666-8666-666666666666";
const CANONICAL_AWARD_FILES = [
  "hasura/functions/leaderboard/get_leaderboard.sql",
  "hasura/functions/tournaments/calculate_tournament_awards.sql",
  "hasura/functions/tournaments/calculate_tournament_trophies.sql",
  "hasura/functions/tournaments/recalculate_tournament_awards.sql",
  "hasura/functions/tournaments/recalculate_tournament_trophies.sql",
  "hasura/triggers/award_recipients.sql",
  "hasura/triggers/awards.sql",
  "hasura/triggers/tournaments.sql",
];

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

describe("awards Phase A exact hybrid-production repair", () => {
  let db: SqlTestDb;

  const AWARD_IDS = [
    "70000000-0000-4000-8000-000000000001",
    "70000000-0000-4000-8000-000000000002",
    "70000000-0000-4000-8000-000000000003",
    "70000000-0000-4000-8000-000000000004",
    "70000000-0000-4000-8000-000000000005",
    "70000000-0000-4000-8000-000000000006",
    "70000000-0000-4000-8000-000000000007",
    "70000000-0000-4000-8000-000000000008",
  ];

  beforeAll(async () => {
    db = await bootContainerAndMigrate("AwardsMigrationHybridProductionTest", {
      version: VERSION,
      prepare: async (postgres) => {
        await postgres.query(
          `ALTER TABLE public.tournaments
             ADD COLUMN awards_enabled boolean NOT NULL DEFAULT true`,
        );
        await postgres.query(`
          CREATE TABLE public.e_award_tiers (
            value text PRIMARY KEY,
            description text NOT NULL
          );
          INSERT INTO public.e_award_tiers(value, description) VALUES
            ('mvp','Most valuable player'), ('gold','First place'),
            ('silver','Second place'), ('bronze','Third place'),
            ('special','Standalone award');

          CREATE TABLE public.e_award_sources (
            value text PRIMARY KEY,
            description text NOT NULL
          );
          INSERT INTO public.e_award_sources(value, description) VALUES
            ('tournament','Calculated from a tournament placement'),
            ('manual','Granted by hand'), ('season','Calculated from a season standing');

          CREATE TABLE public.awards (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            description text,
            tier text NOT NULL DEFAULT 'special' REFERENCES public.e_award_tiers(value),
            silhouette int,
            image_url text,
            system_key text UNIQUE,
            allow_multiple boolean NOT NULL DEFAULT false,
            created_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          );
          INSERT INTO public.awards(id, name, tier, system_key, allow_multiple) VALUES
            ('${AWARD_IDS[0]}','Tournament MVP','mvp','tournament_mvp',true),
            ('${AWARD_IDS[1]}','Tournament Champion','gold','tournament_gold',true),
            ('${AWARD_IDS[2]}','Tournament Runner-Up','silver','tournament_silver',true),
            ('${AWARD_IDS[3]}','Tournament Third Place','bronze','tournament_bronze',true),
            ('${AWARD_IDS[4]}','Season MVP','mvp','season_mvp',true),
            ('${AWARD_IDS[5]}','Season Champion','gold','season_gold',true),
            ('${AWARD_IDS[6]}','Season Runner-Up','silver','season_silver',true),
            ('${AWARD_IDS[7]}','Season Third Place','bronze','season_bronze',true);

          CREATE TABLE public.award_recipients (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
            tournament_team_id uuid NOT NULL REFERENCES public.tournament_teams(id) ON DELETE CASCADE,
            player_steam_id bigint REFERENCES public.players(steam_id) ON DELETE CASCADE,
            team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE,
            placement int NOT NULL CHECK (placement IN (0,1,2,3)),
            award_id uuid REFERENCES public.awards(id) ON DELETE CASCADE,
            source text REFERENCES public.e_award_sources(value),
            awarded_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
            note text,
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE INDEX idx_award_recipients_award
            ON public.award_recipients(award_id);
          CREATE INDEX idx_award_recipients_source
            ON public.award_recipients(tournament_id, source);

          CREATE FUNCTION public.calculate_tournament_awards(uuid)
          RETURNS integer LANGUAGE sql AS 'SELECT 1';

          CREATE FUNCTION public.recalculate_tournament_awards(uuid)
          RETURNS SETOF public.award_recipients
          LANGUAGE sql AS 'SELECT * FROM public.award_recipients';
        `);

        for (const file of CANONICAL_AWARD_FILES) {
          const digest = createHash("sha256")
            .update(fs.readFileSync(path.resolve(file), "utf8"))
            .digest("base64");
          await postgres.query(
            `INSERT INTO migration_hashes.hashes(name, hash)
             VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET hash=excluded.hash`,
            [file.replace(".sql", ""), digest],
          );
        }

        // Match the observed partial psql output: these canonical objects were
        // dropped while their migration_hashes rows remained current.
        await postgres.query(`
          DROP TRIGGER IF EXISTS tau_tournaments_trophies ON public.tournaments;
          DROP FUNCTION IF EXISTS public.tau_tournaments_trophies();
          DROP FUNCTION IF EXISTS public.calculate_tournament_trophies(uuid);
          DROP FUNCTION IF EXISTS public.recalculate_tournament_trophies(uuid);
          DROP FUNCTION IF EXISTS public._leaderboard_trophies(int, text, uuid);
        `);
      },
    });
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("matches and repairs the four-table, two-column, no-manual hybrid", async () => {
    const [awardState] = await db.postgres.query<
      Array<{ count: string; ids: string[] }>
    >(
      `SELECT count(*)::text AS count, array_agg(id::text ORDER BY id) AS ids
         FROM public.awards
        WHERE id = ANY($1::uuid[])`,
      [AWARD_IDS],
    );
    expect(awardState).toEqual({ count: "8", ids: [...AWARD_IDS].sort() });

    const [legacyCount] = await db.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM public.legacy_award_recipients_phase_a`,
    );
    expect(legacyCount.count).toBe("0");

    const columns = await db.postgres.query<Array<{ column_name: string }>>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tournaments'
          AND column_name IN ('awards_enabled','trophies_enabled')
        ORDER BY column_name`,
    );
    expect(columns.map(({ column_name }) => column_name)).toEqual([
      "awards_enabled",
      "trophies_enabled",
    ]);
  });

  it("restores canonical routines, triggers, and compatibility views", async () => {
    const [objects] = await db.postgres.query<
      Array<{
        calculate_awards: string;
        calculate_trophies: string;
        recalculate_awards: string;
        recalculate_trophies: string;
        leaderboard: string;
        trophy_view: string;
        config_view: string;
      }>
    >(`SELECT
      to_regprocedure('public.calculate_tournament_awards(uuid)')::text AS calculate_awards,
      to_regprocedure('public.calculate_tournament_trophies(uuid)')::text AS calculate_trophies,
      to_regprocedure('public.recalculate_tournament_awards(uuid)')::text AS recalculate_awards,
      to_regprocedure('public.recalculate_tournament_trophies(uuid)')::text AS recalculate_trophies,
      to_regprocedure('public._leaderboard_trophies(integer,text,uuid)')::text AS leaderboard,
      to_regclass('public.tournament_trophies')::text AS trophy_view,
      to_regclass('public.tournament_trophy_configs')::text AS config_view`);
    expect(Object.values(objects).every(Boolean)).toBe(true);

    const triggerNames = await db.postgres.query<Array<{ tgname: string }>>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
            'tau_tournaments_trophies',
            'sync_tournament_awards_enabled',
            'tournament_trophies_compat_write',
            'tournament_trophy_configs_compat_write',
            'tbu_awards_guard',
            'tbd_awards_guard',
            'tbu_award_recipients_guard'
          )
        ORDER BY tgname`,
    );
    expect(triggerNames).toHaveLength(7);

    const [returnTypes] = await db.postgres.query<
      Array<{
        calculate_awards: string;
        recalculate_awards: string;
        calculate_trophies: string;
        recalculate_trophies: string;
        leaderboard: string;
      }>
    >(`SELECT
      pg_get_function_result('public.calculate_tournament_awards(uuid)'::regprocedure) AS calculate_awards,
      pg_get_function_result('public.recalculate_tournament_awards(uuid)'::regprocedure) AS recalculate_awards,
      pg_get_function_result('public.calculate_tournament_trophies(uuid)'::regprocedure) AS calculate_trophies,
      pg_get_function_result('public.recalculate_tournament_trophies(uuid)'::regprocedure) AS recalculate_trophies,
      pg_get_function_result('public._leaderboard_trophies(integer,text,uuid)'::regprocedure) AS leaderboard`);
    expect(returnTypes).toEqual({
      calculate_awards: "void",
      recalculate_awards: "SETOF award_occurrences",
      calculate_trophies: "void",
      recalculate_trophies: "SETOF tournament_trophies",
      leaderboard: "SETOF leaderboard_entries",
    });
  });

  it("reapplies canonical SQL once, then skips an unchanged second pass", async () => {
    await db.postgres.query(
      `DELETE FROM migration_hashes.hashes
        WHERE replace(name, E'\\\\', '/') = ANY($1::text[])`,
      [CANONICAL_AWARD_FILES.map((file) => file.replace(".sql", ""))],
    );
    await db.hasura.setup();
    await db.hasura.setup();
    const [{ count }] = await db.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM hdb_catalog.schema_migrations
        WHERE version = ${VERSION}`,
    );
    expect(count).toBe("1");
  }, 600_000);
});
