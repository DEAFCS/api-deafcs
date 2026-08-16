-- Registration check-in for the individual sign-up flow: the organizer
-- starts a check-in window (individual_check_in_duration_minutes long);
-- anyone Registered who hasn't checked in by individual_check_in_ends_at
-- gets auto-removed and replaced from the waitlist by
-- ProcessTournamentCheckInExpiry, which then re-opens a fresh window (same
-- duration) for just the newly-promoted players -- repeating until nobody
-- is removed on a cycle.
alter table "public"."tournaments" add column if not exists "individual_check_in_ends_at" timestamptz;
alter table "public"."tournaments" add column if not exists "individual_check_in_duration_minutes" integer;

alter table "public"."tournament_individual_signups" add column if not exists "checked_in_at" timestamptz;

INSERT INTO "public"."e_tournament_individual_signup_status" ("value", "description") VALUES
  ('Removed', 'Did not check in before the window closed -- replaced from the waitlist')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
