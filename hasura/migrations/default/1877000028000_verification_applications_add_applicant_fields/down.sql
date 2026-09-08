ALTER TABLE "public"."verification_applications"
    DROP COLUMN IF EXISTS "deaf_player_nickname",
    DROP COLUMN IF EXISTS "social_instagram_url",
    DROP COLUMN IF EXISTS "social_facebook_url",
    DROP COLUMN IF EXISTS "social_vk_url",
    DROP COLUMN IF EXISTS "account_declaration_accepted_at",
    ALTER COLUMN "found_via" SET NOT NULL;
