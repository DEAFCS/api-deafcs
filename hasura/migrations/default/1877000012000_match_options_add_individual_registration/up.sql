-- When on, players join a tournament individually instead of as a team --
-- teams get auto-generated (ELO-balanced) once the organizer runs the
-- "Generate Teams" action after closing registration. See
-- tournament_individual_signups for the pending-player pool this feeds.
alter table "public"."match_options" add column if not exists "individual_registration_enabled" boolean
 not null default false;
