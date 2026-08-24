-- Mirrors match_camera_tokens' shape exactly, but is its own table --
-- see DEAFCS/deafcs-web#91 for why streamer_camera_enabled is kept
-- fully separate from camera_required end to end.
CREATE TABLE "public"."match_streamer_camera_tokens" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "match_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade,
    UNIQUE ("token"),
    UNIQUE ("match_id", "steam_id")
);

CREATE INDEX "match_streamer_camera_tokens_match_id_idx" ON "public"."match_streamer_camera_tokens" ("match_id");
