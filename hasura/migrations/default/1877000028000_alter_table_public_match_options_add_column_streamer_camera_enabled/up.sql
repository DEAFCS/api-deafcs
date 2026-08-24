-- Deliberately its own column, not a reuse of camera_required. That
-- column gates the admin-only anti-cheat webcam check (CameraService /
-- match_camera_tokens); this one gates whether a player's camera is
-- published publicly into the live stream overlay. Different audience,
-- different risk profile -- see GitHub issue #91 on deafcs-web.
alter table "public"."match_options" add column if not exists "streamer_camera_enabled" boolean
 not null default false;
