CREATE TABLE IF NOT EXISTS "public"."verification_application_messages" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "application_id" uuid NOT NULL,
    "sender_steam_id" bigint NOT NULL,
    "is_admin" boolean NOT NULL DEFAULT false,
    "message" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "verification_application_messages_application_id_idx"
    ON "public"."verification_application_messages" ("application_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_application_messages_application_id_fkey'
          AND table_name = 'verification_application_messages'
    ) THEN
        ALTER TABLE "public"."verification_application_messages"
        ADD CONSTRAINT "verification_application_messages_application_id_fkey"
        FOREIGN KEY ("application_id")
        REFERENCES "public"."verification_applications" ("id")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'verification_application_messages_sender_steam_id_fkey'
          AND table_name = 'verification_application_messages'
    ) THEN
        ALTER TABLE "public"."verification_application_messages"
        ADD CONSTRAINT "verification_application_messages_sender_steam_id_fkey"
        FOREIGN KEY ("sender_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;
END $$;
