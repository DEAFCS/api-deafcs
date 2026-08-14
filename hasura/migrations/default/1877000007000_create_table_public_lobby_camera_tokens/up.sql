-- Player-facing join token for the optional matchmaking-lobby webcam
-- call (distinct from match_camera_tokens, which is the tournament
-- required-webcam feature and is minted server-side on veto->Live --
-- this one is minted on demand when a player chooses to start/join a
-- lobby call, and used the exact same way: an anonymous phone scanning
-- a QR code has no deafcs.net session of its own).
CREATE TABLE "public"."lobby_camera_tokens" (
    "token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "lobby_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("token"),
    UNIQUE ("lobby_id", "steam_id"),
    FOREIGN KEY ("lobby_id") REFERENCES "public"."lobbies" ("id")
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE
);
