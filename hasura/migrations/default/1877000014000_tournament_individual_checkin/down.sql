alter table "public"."tournament_individual_signups" drop column if exists "checked_in_at";
alter table "public"."tournaments" drop column if exists "individual_check_in_duration_minutes";
alter table "public"."tournaments" drop column if exists "individual_check_in_ends_at";
DELETE FROM "public"."e_tournament_individual_signup_status" WHERE "value" = 'Removed';
