DROP INDEX IF EXISTS "public"."match_options_game_mode_idx";
DROP INDEX IF EXISTS "public"."game_modes_enabled_idx";

ALTER TABLE "public"."match_options" DROP CONSTRAINT IF EXISTS "match_options_game_mode_fkey";
ALTER TABLE "public"."match_options" DROP COLUMN IF EXISTS "game_mode_id";

DROP TABLE IF EXISTS "public"."game_modes";
