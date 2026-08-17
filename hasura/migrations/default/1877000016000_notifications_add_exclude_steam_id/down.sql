ALTER TABLE "public"."notifications" DROP CONSTRAINT IF EXISTS "notifications_exclude_steam_id_fkey";
ALTER TABLE "public"."notifications" DROP COLUMN IF EXISTS "exclude_steam_id";
