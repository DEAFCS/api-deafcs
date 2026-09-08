-- found_via becomes genuinely optional (was NOT NULL); the four new applicant
-- fields (known-player nickname, three social profile URLs) are additive and
-- nullable so every historical application row remains valid as-is.
--
-- account_declaration_accepted_at is also additive/nullable here -- it is
-- deliberately NOT populated by this migration for existing rows (they
-- predate the declaration and never agreed to it), and going forward it is
-- never trusted as client-supplied data: see hasura/triggers/
-- verification_applications.sql, which overwrites it with the server's own
-- clock on every insert and rejects the insert outright if it arrives null.
ALTER TABLE "public"."verification_applications"
    ALTER COLUMN "found_via" DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS "deaf_player_nickname" text,
    ADD COLUMN IF NOT EXISTS "social_instagram_url" text,
    ADD COLUMN IF NOT EXISTS "social_facebook_url" text,
    ADD COLUMN IF NOT EXISTS "social_vk_url" text,
    ADD COLUMN IF NOT EXISTS "account_declaration_accepted_at" timestamptz;
