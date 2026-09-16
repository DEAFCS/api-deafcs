-- Sidebar "Announcements" chat channel: unlike every other chat type
-- (Match, Team, Global, ...), which lives entirely in Redis with a 24h
-- TTL (see ChatService's `chat_${type}_${id}` hash), announcements are
-- meant to stay readable indefinitely for anyone who wasn't online when
-- one was posted -- so they're persisted here instead, read/written
-- directly by ChatService via raw SQL (not tracked in Hasura -- like
-- the rest of chat, this never goes through GraphQL).
CREATE TABLE "public"."announcements" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "author_steam_id" bigint NOT NULL,
    "message" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("author_steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX "announcements_created_at_idx" ON "public"."announcements" ("created_at");
