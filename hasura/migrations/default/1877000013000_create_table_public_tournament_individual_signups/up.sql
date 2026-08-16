-- The pending-player pool for the "individual sign-up" tournament option
-- (match_options.individual_registration_enabled) -- a player joins this
-- pool directly, with no team of their own, until the organizer runs the
-- "Generate Teams" action (TournamentsService.generateIndividualTeams),
-- which ELO-balances everyone here into tournament_teams/tournament_team_roster
-- rows and flips each row's status to Assigned. Anyone left over once teams
-- are full (player count not evenly divisible by team size) stays Waitlisted.
CREATE TABLE "public"."e_tournament_individual_signup_status" (
  "value" text NOT NULL,
  "description" text NOT NULL,
  PRIMARY KEY ("value"),
  UNIQUE ("value")
);

INSERT INTO "public"."e_tournament_individual_signup_status" ("value", "description") VALUES
  ('Registered', 'Waiting for the organizer to generate teams'),
  ('Waitlisted', 'Left over once teams were generated -- not evenly divisible by team size'),
  ('Assigned', 'Placed onto a generated tournament_teams row');

CREATE TABLE "public"."tournament_individual_signups" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tournament_id" uuid NOT NULL,
  "player_steam_id" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'Registered',
  "tournament_team_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("tournament_id", "player_steam_id"),
  FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("player_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("tournament_team_id") REFERENCES "public"."tournament_teams"("id") ON UPDATE cascade ON DELETE set null
);

alter table "public"."tournament_individual_signups"
  add constraint "tournament_individual_signups_status_fkey"
  foreign key ("status")
  references "public"."e_tournament_individual_signup_status"
  ("value") on update cascade on delete restrict;

CREATE INDEX "tournament_individual_signups_tournament_id_idx" ON "public"."tournament_individual_signups" ("tournament_id");
