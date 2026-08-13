-- Per-player, per-type opt-out for the in-app alert bell specifically --
-- deliberately separate from push_notification_preferences (which groups
-- by coarse category): this is only exposed for a small, hand-picked set
-- of individual notification types (see api's
-- in-app-notification-types.ts), so per-type is fine-grained enough to
-- be worth its own column instead of forcing those types into a category.
-- Absence of a row means "use that type's own default" (see
-- inAppDefaultEnabled in in-app-notification-types.ts) -- only explicit
-- choices are stored, same pattern as push_notification_preferences.
CREATE TABLE IF NOT EXISTS "public"."in_app_notification_preferences" (
    "steam_id" bigint NOT NULL,
    "type" text NOT NULL,
    "enabled" boolean NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("steam_id", "type"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY ("type") REFERENCES "public"."e_notification_types" ("value")
        ON UPDATE CASCADE ON DELETE CASCADE
);
