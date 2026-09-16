-- Join token for the general admin<->player webcam call, reachable
-- from the camera icon on every player profile page (distinct from
-- verification_call_tokens, which is scoped to a pending verification
-- application). Mints per (target_steam_id, steam_id) pair: the target
-- player and whichever admin rang them each get their own token, same
-- shape as verification_call_tokens / lobby_camera_tokens.
CREATE TABLE "public"."admin_call_tokens" (
    "token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "target_steam_id" bigint NOT NULL,
    "steam_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("token"),
    UNIQUE ("target_steam_id", "steam_id"),
    FOREIGN KEY ("target_steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE
);
