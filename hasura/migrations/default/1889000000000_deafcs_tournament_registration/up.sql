-- Adapted from 5Stack API c23d0808, MIT Copyright (c) 2025 5Stack.gg; see LICENSE.
-- DEAFCS: additive final-schema migration. Existing rows/data/awards are preserved.
CREATE TABLE IF NOT EXISTS public.e_tournament_registration_types (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_tournament_registration_types ("value", "description") VALUES
    ('teams', 'Only pre-formed teams may register'),
    ('free_agents', 'Only individual players may register; teams are drafted from the pool'),
    ('both', 'Pre-formed teams and individual free agents may both register')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

CREATE TABLE IF NOT EXISTS public.e_tournament_free_agent_statuses (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_tournament_free_agent_statuses ("value", "description") VALUES
    ('registered', 'Signed up and waiting for the draft'),
    ('drafted', 'Placed on a drafted team'),
    ('waitlisted', 'Did not make the cut; first in line if a slot opens'),
    ('withdrawn', 'Left the free agent pool')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS registration_type text NOT NULL DEFAULT 'teams',
    ADD COLUMN IF NOT EXISTS min_role text,
    ADD COLUMN IF NOT EXISTS min_elo integer,
    ADD COLUMN IF NOT EXISTS max_elo integer,
    ADD COLUMN IF NOT EXISTS invite_only boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS check_in_required boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS check_in_setting text NOT NULL DEFAULT 'Captains',
    ADD COLUMN IF NOT EXISTS check_in_opens_before_minutes integer NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS check_in_closes_before_minutes integer NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS check_in_ends_at timestamptz;

-- Reuses e_check_in_settings (Admin / Captains / Players), the same enum
-- match_options.check_in_setting already points at, rather than minting a
-- parallel vocabulary for the same three answers.
COMMENT ON COLUMN public.tournaments.check_in_setting IS 'Who confirms a team: Captains, every rostered Player, or the organizer (Admin)';

-- The regions matches are HOSTED in, not a gate on who may enter: 5stack has no
-- per-player region, so this is a preference the scheduler reads, mirroring
-- team_scrim_settings.regions.
COMMENT ON COLUMN public.tournaments.regions IS 'Preferred server regions for hosted matches';

-- Stamped once, when the window opens, and read as a one-way latch by
-- tournament_check_in_started. NULL means the window has never opened.
COMMENT ON COLUMN public.tournaments.check_in_ends_at IS 'When the check-in window closes; NULL until it opens';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_registration_type_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_registration_type_fkey
            FOREIGN KEY (registration_type)
            REFERENCES public.e_tournament_registration_types (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_min_role_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_min_role_fkey
            FOREIGN KEY (min_role)
            REFERENCES public.e_player_roles (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_setting_fkey') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_setting_fkey
            FOREIGN KEY (check_in_setting)
            REFERENCES public.e_check_in_settings (value)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_elo_range_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_elo_range_check
            CHECK (min_elo IS NULL OR max_elo IS NULL OR max_elo >= min_elo);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_opens_before_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_opens_before_check
            CHECK (check_in_opens_before_minutes BETWEEN 15 AND 240);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_closes_before_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_closes_before_check
            CHECK (check_in_closes_before_minutes BETWEEN 5 AND 60);
    END IF;

    -- Two constraints, not one: a >= 5 gap already implies opens > closes, but
    -- keeping both means the error message names the rule that was broken.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_window_order_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_window_order_check
            CHECK (check_in_opens_before_minutes > check_in_closes_before_minutes);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_check_in_window_length_check') THEN
        ALTER TABLE public.tournaments
            ADD CONSTRAINT tournaments_check_in_window_length_check
            CHECK (check_in_opens_before_minutes - check_in_closes_before_minutes >= 5);
    END IF;
END
$$;

-- The ONE signal everything downstream reads. In Players mode a trigger on
-- tournament_team_roster rolls the individual confirmations up into it, so
-- seeding, standings and the UI never have to know which mode is in force.
ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

ALTER TABLE public.tournament_team_roster
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

CREATE TABLE IF NOT EXISTS public.tournament_free_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'registered' REFERENCES public.e_tournament_free_agent_statuses (value) ON UPDATE CASCADE,
    tournament_team_id uuid REFERENCES public.tournament_teams (id) ON UPDATE CASCADE ON DELETE SET NULL,
    checked_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tournament_free_agents_tournament_id_player_steam_id_key UNIQUE (tournament_id, player_steam_id)
);

-- Load-bearing, not bookkeeping: draft_tournament_free_agent_teams decides WHO
-- gets one of the limited slots purely by this column. ELO only decides which
-- team a selected player lands on, so an early low-rated signup can never be
-- bumped out by a late high-rated one.
COMMENT ON COLUMN public.tournament_free_agents.created_at IS 'Registration priority: decides who makes the cut';

CREATE INDEX IF NOT EXISTS idx_tournament_free_agents_tournament_status
    ON public.tournament_free_agents (tournament_id, status);

-- Marks a team the free-agent draft generated, as opposed to one that
-- registered. The draft's idempotency guard used to be "any tournament_teams
-- row exists", which meant registration_type = 'both' never drafted at all: the
-- first real team that signed up permanently blocked the pool.
ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS is_drafted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tournament_teams.is_drafted IS 'Created by draft_tournament_free_agent_teams rather than registered';

-- A session-scoped unlock rather than a passcode carried on every write: the
-- join flow is a plain Hasura insert into tournament_teams /
-- tournament_free_agents, and there is nowhere on those rows to put a secret
-- the insert trigger could check. The player trades the passcode for a row
-- here once, and the triggers then only ask whether that row exists.
CREATE TABLE IF NOT EXISTS public.tournament_registration_unlocks (
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tournament_id, player_steam_id)
);
-- The missing half of invite_only. Before this, "invite only" meant
-- "passcode only": tournament_registration_unlocks was reachable through
-- unlockTournamentRegistration alone, so an organizer who never handed out a
-- code locked everyone out and had no way to let anyone in.
--
-- Keyed on steam_id rather than on a team, like every other invite table on the
-- platform: the invite has to work whether the player brings a registered team
-- or enters the free-agent pool.
CREATE TABLE IF NOT EXISTS public.tournament_invites (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    invited_by_player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    UNIQUE (tournament_id, steam_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_invites_steam_id
    ON public.tournament_invites (steam_id);

-- Repeated in hasura/enums/notification-types.sql; enums are applied after
-- migrations, so both exist on purpose. The notification specs scrape every
-- quoted value-then-description pair out of any up.sql that mentions
-- e_notification_types and treat it as a notification type -- nothing else in
-- this file has that shape, so the table DDL above can share the migration.
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('TournamentInvite', 'You were invited to register for a tournament')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";
-- The 5stack matchmaking lobby the signup came from. No FK: tad_lobby_players
-- deletes the lobby row once its last member leaves, which would blank out a
-- party that is still queued for a tournament days later. Same call
-- match_lineup_players.party_id already makes.
ALTER TABLE public.tournament_free_agents
    ADD COLUMN IF NOT EXISTS party_id uuid;

CREATE INDEX IF NOT EXISTS idx_tournament_free_agents_party
    ON public.tournament_free_agents (tournament_id, party_id)
    WHERE party_id IS NOT NULL;
-- hasura/functions/generate_secure_invite_code.sql is the maintained
-- definition; generate_utility_invite_code() delegates to it there. Seed it here
-- when it is missing, because migrations run before the functions phase and the
-- tournament_invite_codes.code DEFAULT below would not resolve on a fresh
-- install. Guarded rather than CREATE OR REPLACE so it cannot overwrite a body
-- the functions phase already put in place -- 1880000000000_utility_lineups
-- documents the same trap for generate_invite_code().
DO $do$
BEGIN
    IF to_regprocedure('public.generate_secure_invite_code()') IS NULL THEN
        EXECUTE $fn$
            CREATE FUNCTION public.generate_secure_invite_code() RETURNS text
                LANGUAGE plpgsql
                VOLATILE
                AS $body$
            DECLARE
                alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
                source bytea := gen_random_bytes(10);
                code text := '';
                i int;
            BEGIN
                FOR i IN 0..9 LOOP
                    code := code || substr(alphabet, (get_byte(source, i) % 32) + 1, 1);
                END LOOP;
                RETURN code;
            END;
            $body$;
        $fn$;
    END IF;
END
$do$;


-- A tournament is advertised for weeks, so its way in cannot be a static
-- secret that never expires. A code expires, caps its uses, can be revoked, and
-- records who used it.
CREATE TABLE IF NOT EXISTS public.tournament_invite_codes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    code text NOT NULL DEFAULT public.generate_secure_invite_code(),

    -- NULL is "never expires" / "unlimited" rather than a sentinel date or
    -- count that every reader has to remember not to compare against.
    expires_at timestamptz,
    max_uses integer,

    uses integer NOT NULL DEFAULT 0,
    revoked_at timestamptz,
    created_by_player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),

    -- Deliberately not partial. A revoked code staying reserved forever is the
    -- safe failure, and the alternative is not available anyway: an index
    -- predicate over now() is impossible because now() is not immutable.
    UNIQUE (code),

    CONSTRAINT tournament_invite_codes_max_uses_positive
        CHECK (max_uses IS NULL OR max_uses > 0),
    CONSTRAINT tournament_invite_codes_uses_not_negative
        CHECK (uses >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tournament_invite_codes_tournament
    ON public.tournament_invite_codes (tournament_id);


-- "See who used it": the organizer's audit of a link they published.
CREATE TABLE IF NOT EXISTS public.tournament_invite_code_uses (
    invite_code_id uuid NOT NULL REFERENCES public.tournament_invite_codes (id) ON UPDATE CASCADE ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,

    -- Which team they brought, once they bring one. A redemption grants entry
    -- to the player, so this is NULL at the moment the code is spent.
    team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE SET NULL,

    used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (invite_code_id, player_steam_id)
);


-- Tournaments recruit teams, not only players. One table rather than a sibling:
-- a tournament_team_invite* name would collide with tournament_team_invites,
-- which already means "join a team that is registered".
ALTER TABLE public.tournament_invites
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.tournament_invites
    ALTER COLUMN steam_id DROP NOT NULL;

ALTER TABLE public.tournament_invites
    DROP CONSTRAINT IF EXISTS tournament_invites_tournament_id_steam_id_key;

ALTER TABLE public.tournament_invites
    DROP CONSTRAINT IF EXISTS tournament_invites_addressed_once;

ALTER TABLE public.tournament_invites
    ADD CONSTRAINT tournament_invites_addressed_once
        CHECK (num_nonnulls(steam_id, team_id) = 1);

-- The plain UNIQUE (tournament_id, steam_id) stops deduping the moment steam_id
-- can be NULL -- every NULL is distinct to a unique index, so a table of team
-- invites would all be "unique" on the player half. Two partial indexes instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_invites_player_unique
    ON public.tournament_invites (tournament_id, steam_id)
    WHERE steam_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_invites_team_unique
    ON public.tournament_invites (tournament_id, team_id)
    WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournament_invites_team_id
    ON public.tournament_invites (team_id);


-- An unlock is now either player-scoped or team-scoped, on the same shape as
-- the invite that grants it. A team-scoped row carries no player: it is the
-- team that was let in, and whoever may register that team inherits it.
ALTER TABLE public.tournament_registration_unlocks
    ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams (id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Before the DROP NOT NULL, not after: a column still in a primary key cannot
-- become nullable.
ALTER TABLE public.tournament_registration_unlocks
    DROP CONSTRAINT IF EXISTS tournament_registration_unlocks_pkey;

ALTER TABLE public.tournament_registration_unlocks
    ALTER COLUMN player_steam_id DROP NOT NULL;

ALTER TABLE public.tournament_registration_unlocks
    DROP CONSTRAINT IF EXISTS tournament_registration_unlocks_scoped_once;

ALTER TABLE public.tournament_registration_unlocks
    ADD CONSTRAINT tournament_registration_unlocks_scoped_once
        CHECK (num_nonnulls(player_steam_id, team_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_registration_unlocks_player
    ON public.tournament_registration_unlocks (tournament_id, player_steam_id)
    WHERE team_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_registration_unlocks_team
    ON public.tournament_registration_unlocks (tournament_id, team_id)
    WHERE team_id IS NOT NULL;


-- Two fences for the two passes ProcessTournamentCheckIn runs against a
-- deadline, each holding the deadline it has already acted on rather than a
-- flag. The deadline is what moves when an organizer extends the window, so
-- storing it is what makes an extension earn a fresh reminder and a fresh close
-- without either firing twice for the same one.
--
-- The status can no longer answer either question: extending now leaves the
-- tournament held in CheckInReview (flipping it back to RegistrationOpen
-- re-opened registration to newcomers, which an extension never meant), so
-- "held for review" and "held for review with a live extension" are the same
-- status.
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS check_in_closed_for timestamptz,
    ADD COLUMN IF NOT EXISTS check_in_closing_notified_for timestamptz;

COMMENT ON COLUMN public.tournaments.check_in_closed_for IS 'The check_in_ends_at the close pass has already acted on';
COMMENT ON COLUMN public.tournaments.check_in_closing_notified_for IS 'The check_in_ends_at the closing reminder was sent for';

-- Backfill, or every tournament already sitting in review re-closes and
-- re-notifies its whole field the first time the job runs after this deploy.
UPDATE public.tournaments
   SET check_in_closed_for = check_in_ends_at
 WHERE check_in_ends_at IS NOT NULL
   AND check_in_closed_for IS NULL
   AND status NOT IN ('Setup', 'RegistrationOpen');

-- Existing tournaments keep their deployed attendance/Random semantics.
-- Only tournaments inserted after this migration use the unified registration engine.
ALTER TABLE public.tournaments ADD COLUMN registration_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.tournaments ALTER COLUMN registration_version SET DEFAULT 2;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_registration_version_check CHECK (registration_version IN (1, 2));
INSERT INTO public.e_tournament_status (value, description) VALUES ('CheckInReview', 'Check-in review') ON CONFLICT (value) DO NOTHING;
