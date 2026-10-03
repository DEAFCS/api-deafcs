-- Up to 5 saved reply texts per staff member for answering verification
-- applications. Private to the owner (see the Hasura permissions).
CREATE TABLE IF NOT EXISTS "public"."admin_reply_templates" (
    "owner_steam_id" bigint NOT NULL,
    "slot" smallint NOT NULL,
    "title" text NOT NULL DEFAULT '',
    "body" text NOT NULL,
    PRIMARY KEY ("owner_steam_id", "slot"),
    CONSTRAINT "admin_reply_templates_slot_check" CHECK ("slot" BETWEEN 1 AND 5),
    CONSTRAINT "admin_reply_templates_body_length_check" CHECK (char_length("body") <= 4000),
    CONSTRAINT "admin_reply_templates_title_length_check" CHECK (char_length("title") <= 60)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'admin_reply_templates_owner_steam_id_fkey'
          AND table_name = 'admin_reply_templates'
    ) THEN
        ALTER TABLE "public"."admin_reply_templates"
        ADD CONSTRAINT "admin_reply_templates_owner_steam_id_fkey"
        FOREIGN KEY ("owner_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE
        ON DELETE CASCADE;
    END IF;
END $$;
