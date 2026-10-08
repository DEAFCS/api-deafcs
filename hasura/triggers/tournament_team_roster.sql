CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
BEGIN
    -- Max players only on joining (adapted from 5Stack): a lowered cap must
    -- not block a roster shedding players, or a role change on a full roster.
    IF TG_OP = 'DELETE' THEN
        PERFORM check_team_eligibility(OLD, false);
    ELSIF TG_OP = 'INSERT' THEN
        PERFORM check_team_eligibility(NEW, true);
    ELSE
        PERFORM check_team_eligibility(NEW, NEW.tournament_team_id IS DISTINCT FROM OLD.tournament_team_id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER taiud_tournament_team_roster
    AFTER INSERT OR DELETE
    OR UPDATE OF tournament_team_id, player_steam_id, tournament_id, role
    ON public.tournament_team_roster
    FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbd_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _min_players int;
    _roster_count int;
BEGIN
    SELECT t.* INTO _tournament
        FROM tournament_teams tt
        JOIN tournaments t ON t.id = tt.tournament_id
        WHERE tt.id = OLD.tournament_team_id;

    -- When the whole team (or the tournament) is being deleted its
    -- tournament_teams row is already gone by the time this cascade fires, so
    -- the join finds nothing and we let the roster rows cascade through.
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    -- Rosters are only locked once the bracket has been seeded. Before that
    -- (Setup / RegistrationOpen) teams edit their lineup freely and dropping
    -- below the minimum just makes them ineligible.
    IF (_tournament.registration_version = 2 AND _tournament.status NOT IN ('Live', 'Paused'))
       OR (_tournament.registration_version = 1 AND _tournament.status NOT IN ('RegistrationClosed', 'Live', 'Paused')) THEN
        RETURN OLD;
    END IF;

    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _roster_count
        FROM tournament_team_roster ttr
        WHERE ttr.tournament_team_id = OLD.tournament_team_id;

    -- Removing this player would strip the team's eligibility and seed while the
    -- tournament is underway. A team can only swap a player out if it has a
    -- substitute keeping it at or above the minimum lineup.
    IF _roster_count - 1 < _min_players THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'Cannot remove player: the team would drop below the minimum lineup of ' || _min_players || ' players while the tournament is underway';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbd_tournament_team_roster BEFORE DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbd_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbi_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
    _owner_steam_id bigint;
    _tournament public.tournaments;
    _hasura_session json := current_setting('hasura.user', true)::json;
BEGIN
    -- Player eligibility is checked unconditionally, before the
    -- admin/organizer bypass and before the free-agent invite redirect
    -- below: management authorization (who may write to this roster) and
    -- target-player eligibility (tournament.min_role) are independent, and
    -- this is the one path every insert into this table goes through --
    -- Hasura's declarative `check` can't be relied on alone here, since the
    -- invite-redirect branch returns NULL (zero rows), which would leave
    -- nothing for a RETURNING-based permission check to evaluate.
    --
    -- `IS NOT TRUE`, not `NOT ...`: player_meets_min_role can return NULL
    -- (fail-closed, same as meets_min_role), and PL/pgSQL's IF treats a NULL
    -- condition as false -- `NOT NULL` is NULL, so a plain `IF NOT ...`
    -- would silently skip the exception instead of raising it.
    IF public.player_meets_tournament_requirements(NEW.tournament_id, NEW.player_steam_id) IS NOT TRUE THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'Target player does not meet this tournament''s entry requirements';
    END IF;

    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id;

    -- The system draft bypasses invite redirection, never target eligibility.
    IF current_setting('fivestack.free_agent_draft', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF _hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator')
       OR (FOUND AND public.is_tournament_organizer(_tournament, _hasura_session)) THEN
        RETURN NEW;
    END IF;

    SELECT team_id, owner_steam_id INTO _team_id, _owner_steam_id FROM tournament_teams WHERE id = NEW.tournament_team_id;

    IF _team_id IS NULL THEN
        IF _owner_steam_id = NEW.player_steam_id THEN
            NEW.role = 'Admin';
            RETURN NEW;
        END IF;

        -- Accepting your own pending invite: an authorized team admin/owner
        -- already extended it (that's how the invite row got there in the
        -- first place -- see the INSERT below), so this is a direct insert,
        -- not another invite to redirect into. Without this branch, a
        -- self-accept (player_steam_id = the acting session) would loop
        -- back into the INSERT below and collide with the existing invite's
        -- unique constraint instead of ever landing on the roster.
        IF NEW.player_steam_id = (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint
           AND EXISTS (
               SELECT 1 FROM tournament_team_invites
               WHERE tournament_team_id = NEW.tournament_team_id
                 AND steam_id = NEW.player_steam_id
           ) THEN
            RETURN NEW;
        END IF;

        INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
            VALUES (NEW.tournament_team_id, NEW.player_steam_id, (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint);

        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbi_tournament_team_roster BEFORE INSERT ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_roster();

CREATE OR REPLACE FUNCTION public.tbi_tournament_team_roster_snapshot() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _status text;
BEGIN
    SELECT t.status
      INTO _status
      FROM public.tournament_teams tt
      INNER JOIN public.tournaments t ON t.id = tt.tournament_id
     WHERE tt.id = NEW.tournament_team_id;

    IF _status IN ('RegistrationClosed', 'Live', 'Paused', 'Finished') THEN
        NEW.roster_image_url_snapshot :=
            public.resolve_tournament_roster_image_snapshot(
                NEW.tournament_team_id,
                NEW.player_steam_id
            );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_roster_snapshot ON public.tournament_team_roster;
CREATE TRIGGER tbi_tournament_team_roster_snapshot
    BEFORE INSERT ON public.tournament_team_roster
    FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_roster_snapshot();


-- Adapted from 5Stack API c23d0808; MIT Copyright (c) 2025 5Stack.gg.
-- Dropped before it is rebuilt: the function grew a DELETE path and with it a
-- new name, and the old pair would otherwise both survive a re-apply.
DROP TRIGGER IF EXISTS taiu_tournament_team_roster_check_in ON public.tournament_team_roster;
DROP TRIGGER IF EXISTS taiud_tournament_team_roster_check_in ON public.tournament_team_roster;
DROP FUNCTION IF EXISTS public.taiu_tournament_team_roster_check_in();

CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster_check_in() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _tournament_id uuid;
    _tournament_team_id uuid;
    _confirmation_lost boolean;
    _min_players int;
    _checked_in int;
BEGIN
    -- Only a real change to this player's own confirmation can move the team's
    -- rollup. Recomputing on every roster write would let adding a substitute
    -- wipe a checked-in (or organizer re-admitted) team.
    IF TG_OP = 'UPDATE' AND NEW.checked_in_at IS NOT DISTINCT FROM OLD.checked_in_at THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.checked_in_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- Dropping a confirmed player is a withdrawn confirmation with the row
    -- removed: the count it was part of is gone either way, so a team that
    -- falls back under the minimum lineup has to lose its roll-up here too.
    -- Left to the UPDATE path alone, a captain could seed an unconfirmed lineup
    -- into the bracket simply by removing the people who confirmed it.
    IF TG_OP = 'DELETE' THEN
        IF OLD.checked_in_at IS NULL THEN
            RETURN OLD;
        END IF;

        _tournament_id := OLD.tournament_id;
        _tournament_team_id := OLD.tournament_team_id;
        _confirmation_lost := true;
    ELSE
        _tournament_id := NEW.tournament_id;
        _tournament_team_id := NEW.tournament_team_id;
        _confirmation_lost := NEW.checked_in_at IS NULL;
    END IF;

    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Captains and Admin modes stamp tournament_teams.checked_in_at directly;
    -- per-player rows carry no authority there.
    IF NOT _tournament.check_in_required OR _tournament.check_in_setting <> 'Players' THEN
        RETURN NULL;
    END IF;

    -- The bar is the MINIMUM LINEUP, not the whole roster: a roster of seven
    -- (five starters plus two substitutes) only fields five, and a substitute
    -- who is not playing must not be able to hold the team out of the bracket.
    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _checked_in
      FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_team_id = _tournament_team_id
       AND ttr.checked_in_at IS NOT NULL;

    IF _checked_in >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = now()
         WHERE tt.id = _tournament_team_id
           AND tt.checked_in_at IS NULL;

    -- Clearing is only ever a LOST confirmation breaking a roll-up that was
    -- already satisfied -- this row went from stamped to NULL (or left the
    -- roster stamped), so the count was _checked_in + 1 a moment ago. A player
    -- CHECKING IN can only raise the count, and reacting to that would let the
    -- first player to confirm wipe a team the registration auto-stamp or an
    -- organizer re-admit had already checked in: they would harm their own team
    -- by doing what the UI asked.
    ELSIF _confirmation_lost AND _checked_in + 1 >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = NULL
         WHERE tt.id = _tournament_team_id
           AND tt.checked_in_at IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$;

-- UPDATE OF checked_in_at, but DELETE unqualified: a delete carries no column
-- list to narrow on, and the row taking its stamp with it is exactly the case
-- the clear branch exists for.
CREATE TRIGGER taiud_tournament_team_roster_check_in
    AFTER INSERT OR DELETE OR UPDATE OF checked_in_at ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taiud_tournament_team_roster_check_in();

-- A roster change must reach the team's matches that exist but have not
-- started. Round 1 is created when registration closes, so a roster edited
-- between close and start (or before a later round is played) would otherwise
-- leave the lineup seating players who were removed and missing players who
-- were added. The work is in refresh_unstarted_tournament_team_lineups, which
-- only touches Scheduled and WaitingForCheckIn matches. A cascade from a
-- deleted team or tournament is skipped (the team row is already gone).
CREATE OR REPLACE FUNCTION public.taid_tournament_team_roster_refresh_lineups() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- A removed tournament captain is replaced first, so the refresh below
    -- already seats the new captain.
    IF TG_OP = 'DELETE' THEN
        PERFORM public.replace_removed_tournament_captain(
            OLD.tournament_team_id,
            OLD.player_steam_id
        );
    END IF;

    PERFORM public.refresh_unstarted_tournament_team_lineups(
        COALESCE(NEW.tournament_team_id, OLD.tournament_team_id)
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taid_tournament_team_roster_refresh_lineups ON public.tournament_team_roster;
CREATE TRIGGER taid_tournament_team_roster_refresh_lineups
    AFTER INSERT OR DELETE ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taid_tournament_team_roster_refresh_lineups();
