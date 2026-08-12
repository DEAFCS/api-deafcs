alter table "public"."match_options" add column if not exists "camera_required" boolean
 not null default false;
