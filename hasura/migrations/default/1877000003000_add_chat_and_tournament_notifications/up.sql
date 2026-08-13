INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('ChatMessage', 'New chat message'),
    ('TournamentCreated', 'A new tournament was created'),
    ('TournamentReminder', 'A tournament you are registered for starts soon')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

-- Per-player, per-category push opt-out. Absence of a row means enabled
-- (the default) -- only explicit choices are stored, so every existing
-- and future player is opted in without needing to backfill anything.
CREATE TABLE IF NOT EXISTS "public"."push_notification_preferences" (
    "steam_id" bigint NOT NULL,
    "category" text NOT NULL,
    "enabled" boolean NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("steam_id", "category"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE
);
