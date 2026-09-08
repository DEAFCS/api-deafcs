-- Multi-reference known-player list, replacing the single
-- deaf_player_nickname/deaf_player_steam_url pair on verification_applications
-- for NEW submissions. Those two legacy columns are deliberately left
-- untouched (not dropped, not backfilled) -- two production applications
-- already have real data in deaf_player_steam_url, and this migration is
-- purely additive; the admin detail page keeps rendering them for any
-- historical row that has them.
--
-- ON DELETE CASCADE matches verification_application_messages' own FK to
-- this same parent table exactly: this is evidence attached to one
-- application, not player-owned preference data, so it only ever goes away
-- when the application itself does (already an admin-only, filter: {}
-- delete permission).
CREATE TABLE IF NOT EXISTS "public"."verification_application_known_players" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "verification_application_id" uuid NOT NULL,
    "nickname" text,
    "steam_profile_url" text,
    -- Bounded to 1..3 and unique per application -- together these two
    -- constraints make a 4th reference for the same application
    -- impossible at the database level, not just in client-side UI: a 4th
    -- row would need a sort_order outside [1,3] (rejected by the CHECK) or
    -- would collide with an existing row's sort_order (rejected by the
    -- UNIQUE constraint). No trigger needed for this invariant.
    "sort_order" integer NOT NULL CHECK ("sort_order" BETWEEN 1 AND 3),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    UNIQUE ("verification_application_id", "sort_order"),
    -- A row with both fields blank/null identifies nobody and is
    -- meaningless -- each field stays individually optional (either one
    -- alone is a valid reference), but at least one must carry real
    -- content. Enforced here so a direct GraphQL insert (bypassing the
    -- client's own filter of empty rows) can't create one either.
    CONSTRAINT "verification_application_known_players_not_blank_check" CHECK (
        NULLIF(BTRIM("nickname"), '') IS NOT NULL
        OR NULLIF(BTRIM("steam_profile_url"), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS "verification_application_known_players_application_id_idx"
    ON "public"."verification_application_known_players" ("verification_application_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_application_known_players_application_id_fkey'
          AND table_name = 'verification_application_known_players'
    ) THEN
        ALTER TABLE "public"."verification_application_known_players"
        ADD CONSTRAINT "verification_application_known_players_application_id_fkey"
        FOREIGN KEY ("verification_application_id")
        REFERENCES "public"."verification_applications" ("id")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;
END $$;
