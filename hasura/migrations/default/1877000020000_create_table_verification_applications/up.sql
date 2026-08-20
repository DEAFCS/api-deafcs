CREATE TABLE IF NOT EXISTS "public"."e_verification_application_statuses" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

INSERT INTO "public"."e_verification_application_statuses" ("value", "description") VALUES
    ('pending', 'Waiting for an admin to review'),
    ('approved', 'Approved, player was verified'),
    ('rejected', 'Rejected')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

CREATE TABLE IF NOT EXISTS "public"."e_verification_deaf_statuses" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

INSERT INTO "public"."e_verification_deaf_statuses" ("value", "description") VALUES
    ('yes', 'Deaf'),
    ('no', 'Not deaf'),
    ('hard_of_hearing', 'Hard of hearing')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";

CREATE TABLE IF NOT EXISTS "public"."verification_applications" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "player_steam_id" bigint NOT NULL,
    "is_deaf" text NOT NULL,
    "country" text NOT NULL,
    "found_via" text NOT NULL,
    "knows_deaf_player" boolean NOT NULL DEFAULT false,
    "deaf_player_steam_url" text,
    "status" text NOT NULL DEFAULT 'pending',
    "reviewed_by_steam_id" bigint,
    "reviewed_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);

-- Only one open (pending) application per player at a time -- a rejected
-- player can submit a new one (new row), but can't queue up several pending
-- applications in parallel.
CREATE UNIQUE INDEX IF NOT EXISTS "verification_applications_one_pending_per_player"
    ON "public"."verification_applications" ("player_steam_id")
    WHERE ("status" = 'pending');

CREATE INDEX IF NOT EXISTS "verification_applications_player_steam_id_idx"
    ON "public"."verification_applications" ("player_steam_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_applications_player_steam_id_fkey'
          AND table_name = 'verification_applications'
    ) THEN
        ALTER TABLE "public"."verification_applications"
        ADD CONSTRAINT "verification_applications_player_steam_id_fkey"
        FOREIGN KEY ("player_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_applications_reviewed_by_steam_id_fkey'
          AND table_name = 'verification_applications'
    ) THEN
        ALTER TABLE "public"."verification_applications"
        ADD CONSTRAINT "verification_applications_reviewed_by_steam_id_fkey"
        FOREIGN KEY ("reviewed_by_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE
        ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_applications_status_fkey'
          AND table_name = 'verification_applications'
    ) THEN
        ALTER TABLE "public"."verification_applications"
        ADD CONSTRAINT "verification_applications_status_fkey"
        FOREIGN KEY ("status")
        REFERENCES "public"."e_verification_application_statuses" ("value")
        ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_applications_is_deaf_fkey'
          AND table_name = 'verification_applications'
    ) THEN
        ALTER TABLE "public"."verification_applications"
        ADD CONSTRAINT "verification_applications_is_deaf_fkey"
        FOREIGN KEY ("is_deaf")
        REFERENCES "public"."e_verification_deaf_statuses" ("value")
        ON UPDATE CASCADE;
    END IF;
END $$;
