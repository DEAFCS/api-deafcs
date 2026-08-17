-- Role-broadcast notifications (steam_id IS NULL, e.g. GlobalChatMessage
-- and OrganizerChatMessage) had no way to exclude the sender from the
-- resolved recipient list -- every player matching the role got notified,
-- including whoever just sent the message themselves (on every one of
-- their own devices/sessions).
ALTER TABLE "public"."notifications"
  ADD COLUMN "exclude_steam_id" bigint;

ALTER TABLE "public"."notifications"
  ADD CONSTRAINT "notifications_exclude_steam_id_fkey"
  FOREIGN KEY ("exclude_steam_id") REFERENCES "public"."players"("steam_id")
  ON UPDATE CASCADE ON DELETE SET NULL;
