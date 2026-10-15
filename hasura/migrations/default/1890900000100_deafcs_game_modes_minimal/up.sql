-- DEAFCS port of the minimum upstream 5Stack game-modes schema the utility
-- practice system needs (UtilityPracticeModeService installs the system
-- 'utility-practice' mode and practice matches reference it through
-- match_options.game_mode_id).
--
-- Upstream sources (5stackgg/api 58545c47edb98a5567dc66cf5f705548775baae7):
--   1878000000000_game_plugins_and_modes  (game_modes table, match_options.game_mode_id)
--   1889000001400_game_mode_templates     (game_modes.system)
--
-- Renumbered: upstream 1878000000000 collides with DEAFCS
-- 1878000000000_create_support_requests, and the migration runner tracks
-- versions by number. 18909xxxxxxxx is the DEAFCS-reserved range for upstream
-- prerequisites ported under a new number.
--
-- Deliberately NOT ported here: game_plugins, game_plugin_versions,
-- game_plugin_installs, game_server_node_plugins, game_mode_plugins,
-- servers.game_mode_id, custom_pages.plugin_slug, matches.counts_toward_ranking,
-- the starter mode templates and hasura/triggers/game_modes.sql. Existing DEAFCS
-- match modes (Competitive, Wingman, Duel, tournaments, Captain Pick) are not
-- touched: every existing match_options row keeps game_mode_id NULL.

CREATE TABLE IF NOT EXISTS "public"."game_modes" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "slug" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "icon" text,
    "enabled" boolean NOT NULL DEFAULT true,
    -- Retiring a mode archives it rather than deleting it: a finished match
    -- keeps naming the mode it was played under.
    "archived_at" timestamptz,
    -- Whether a ranked or matchmaking match may run this mode. Defaults to
    -- false so a newly created mode can never reach ranked play by accident.
    "competitive_safe" boolean NOT NULL DEFAULT false,
    "cfg" text,
    "extra_game_params" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    CONSTRAINT "game_modes_slug_key" UNIQUE ("slug"),
    CONSTRAINT "game_modes_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

ALTER TABLE public.game_modes
    ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;

ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "game_mode_id" uuid;

DO $$
BEGIN
    ALTER TABLE "public"."match_options"
        ADD CONSTRAINT "match_options_game_mode_fkey" FOREIGN KEY ("game_mode_id")
            REFERENCES "public"."game_modes" ("id") ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS "game_modes_enabled_idx"
    ON "public"."game_modes" ("enabled") WHERE "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "match_options_game_mode_idx"
    ON "public"."match_options" ("game_mode_id") WHERE "game_mode_id" IS NOT NULL;
