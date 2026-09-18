CREATE OR REPLACE FUNCTION public.tbi_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _owner_steam_id bigint;
BEGIN
    NEW.role = 'Member';

    SELECT owner_steam_id INTO _owner_steam_id FROM teams WHERE id = NEW.team_id;

    IF _owner_steam_id = NEW.player_steam_id THEN 
        NEW.role = 'Admin';
        RETURN NEW;
    END IF;

   IF current_setting('hasura.user')::jsonb ->> 'x-hasura-role' IN ('admin', 'administrator') THEN
        RETURN NEW;
    END IF;

    INSERT INTO team_invites (team_id, steam_id, invited_by_player_steam_id)
        VALUES (NEW.team_id, NEW.player_steam_id, (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint);

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tbi_team_roster ON public.team_roster;
CREATE TRIGGER tbi_team_roster BEFORE INSERT ON public.team_roster FOR EACH ROW EXECUTE FUNCTION public.tbi_team_roster();

-- Every operation that can remove Admin access locks the parent team row.
-- Concurrent role changes/removals for the same team therefore serialize, so
-- the second transaction observes the first transaction's committed result.
-- A cascading team deletion has already removed the parent row and is allowed.
CREATE OR REPLACE FUNCTION public.tbud_team_roster_admin_guard() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _session_text text;
    _session jsonb := '{}'::jsonb;
    _actor_role text;
    _actor_steam_id bigint;
    _owner_steam_id bigint;
    _admin_count integer;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
        RETURN NEW;
    END IF;

    SELECT owner_steam_id
    INTO _owner_steam_id
    FROM public.teams
    WHERE id = OLD.team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        -- ON DELETE CASCADE from a deliberate team deletion/disband.
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    _session_text := current_setting('hasura.user', true);
    IF NULLIF(_session_text, '') IS NOT NULL THEN
        _session := _session_text::jsonb;
        _actor_role := _session ->> 'x-hasura-role';
        IF NULLIF(_session ->> 'x-hasura-user-id', '') IS NOT NULL THEN
            _actor_steam_id := (_session ->> 'x-hasura-user-id')::bigint;
        END IF;
    END IF;

    IF _actor_role IS NOT NULL
        AND _actor_role NOT IN ('admin', 'administrator', 'tournament_organizer')
        AND _actor_steam_id IS DISTINCT FROM _owner_steam_id
        AND NOT (
            TG_OP = 'DELETE'
            AND _actor_steam_id = OLD.player_steam_id
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.team_roster
            WHERE team_id = OLD.team_id
              AND player_steam_id = _actor_steam_id
              AND role = 'Admin'
        ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'You are not authorized to manage this team roster.';
    END IF;

    IF OLD.role = 'Admin'
        AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'Admin') THEN
        SELECT count(*)
        INTO _admin_count
        FROM public.team_roster
        WHERE team_id = OLD.team_id
          AND role = 'Admin';

        IF _admin_count <= 1 THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'You are the last team Admin. Assign another Admin before changing your role or leaving the team.';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS tbud_team_roster_admin_guard ON public.team_roster;
CREATE TRIGGER tbud_team_roster_admin_guard
    BEFORE UPDATE OF role OR DELETE ON public.team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tbud_team_roster_admin_guard();

-- Re-check at transaction end under a per-team advisory lock. This closes the
-- write-skew window where two requests start while two Admins still exist and
-- each request removes a different one.
CREATE OR REPLACE FUNCTION public.ct_team_roster_admin_guard() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.team_id::text, 0));

    IF EXISTS (
        SELECT 1 FROM public.teams WHERE id = OLD.team_id
    ) AND NOT EXISTS (
        SELECT 1
        FROM public.team_roster
        WHERE team_id = OLD.team_id
          AND role = 'Admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'You are the last team Admin. Assign another Admin before changing your role or leaving the team.';
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ct_team_roster_admin_guard ON public.team_roster;
CREATE CONSTRAINT TRIGGER ct_team_roster_admin_guard
    AFTER UPDATE OR DELETE ON public.team_roster
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.role = 'Admin')
    EXECUTE FUNCTION public.ct_team_roster_admin_guard();

CREATE OR REPLACE FUNCTION public.taiud_team_roster_admin_audit() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _previous_role text;
    _new_role text;
    _action text;
    _reason text;
    _session_text text;
    _session jsonb := '{}'::jsonb;
    _actor_steam_id bigint;
    _actor_role text;
BEGIN
    _previous_role := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.role ELSE NULL END;
    _new_role := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.role ELSE NULL END;

    IF _previous_role IS NOT DISTINCT FROM _new_role
        OR (_previous_role IS DISTINCT FROM 'Admin' AND _new_role IS DISTINCT FROM 'Admin') THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    _session_text := current_setting('hasura.user', true);
    IF NULLIF(_session_text, '') IS NOT NULL THEN
        _session := _session_text::jsonb;
        _actor_role := _session ->> 'x-hasura-role';
        IF NULLIF(_session ->> 'x-hasura-user-id', '') IS NOT NULL THEN
            _actor_steam_id := (_session ->> 'x-hasura-user-id')::bigint;
        END IF;
    END IF;

    _action := NULLIF(current_setting('fivestack.team_admin_audit_action', true), '');
    _reason := NULLIF(current_setting('fivestack.team_admin_audit_reason', true), '');

    IF _action IS NULL THEN
        IF TG_OP = 'INSERT' THEN
            _action := 'admin_granted';
        ELSIF TG_OP = 'DELETE' AND NOT EXISTS (
            SELECT 1 FROM public.teams WHERE id = OLD.team_id
        ) THEN
            _action := 'team_deleted';
        ELSIF TG_OP = 'DELETE' THEN
            _action := 'admin_removed';
        ELSIF _new_role = 'Admin' THEN
            _action := 'admin_granted';
        ELSE
            _action := 'admin_revoked';
        END IF;
    END IF;

    INSERT INTO public.team_admin_audit (
        team_id,
        player_steam_id,
        previous_role,
        new_role,
        action,
        reason,
        actor_steam_id,
        actor_role
    ) VALUES (
        CASE WHEN TG_OP = 'DELETE' THEN OLD.team_id ELSE NEW.team_id END,
        CASE WHEN TG_OP = 'DELETE' THEN OLD.player_steam_id ELSE NEW.player_steam_id END,
        _previous_role,
        _new_role,
        _action,
        _reason,
        _actor_steam_id,
        _actor_role
    );

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS taiud_team_roster_admin_audit ON public.team_roster;
CREATE TRIGGER taiud_team_roster_admin_audit
    AFTER INSERT OR UPDATE OF role OR DELETE ON public.team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taiud_team_roster_admin_audit();

CREATE OR REPLACE FUNCTION public.tad_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _owner_steam_id bigint;
BEGIN
    -- Leaving the team drops the player from any ACTIVE league roster (season
    -- not yet finished/canceled), preserving history via soft-delete. The GUC
    -- lets the league roster trigger stand aside from the lock check.
    PERFORM set_config('fivestack.league_cascade', 'true', true);
    UPDATE public.league_team_rosters ltr
    SET removed_at = NOW(),
        removed_reason = 'Left team'
    FROM public.league_team_seasons lts
    JOIN public.league_teams lt ON lt.id = lts.league_team_id
    JOIN public.league_seasons ls ON ls.id = lts.league_season_id
    WHERE ltr.league_team_season_id = lts.id
      AND ltr.player_steam_id = OLD.player_steam_id
      AND ltr.removed_at IS NULL
      AND lt.team_id = OLD.team_id
      AND ls.status NOT IN ('Finished', 'Canceled');
    PERFORM set_config('fivestack.league_cascade', 'false', true);

    IF EXISTS (
        SELECT 1
        FROM teams t
        WHERE t.id = OLD.team_id
          AND t.captain_steam_id = OLD.player_steam_id
    ) THEN
        SELECT owner_steam_id
        INTO _owner_steam_id
        FROM teams
        WHERE id = OLD.team_id;

        IF _owner_steam_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM team_roster tr
                WHERE tr.team_id = OLD.team_id
                  AND tr.player_steam_id = _owner_steam_id
            ) THEN
            UPDATE teams
            SET captain_steam_id = _owner_steam_id
            WHERE id = OLD.team_id;
        ELSE
            UPDATE teams
            SET captain_steam_id = NULL
            WHERE id = OLD.team_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_team_roster ON public.team_roster;
CREATE TRIGGER tad_team_roster AFTER DELETE ON public.team_roster FOR EACH ROW EXECUTE FUNCTION public.tad_team_roster();
-- Roster status caps: always 5 starters and team_max_subs() substitutes per
-- team. On insert a would-be starter cascades down to the next open slot
-- (Starter -> Substitute -> Benched) so adding a player never fails; an
-- explicit promotion once a tier is full is rejected. A coach does not
-- occupy a playing slot: NEW.coach rows are exempt from the cap check, and
-- existing coach rows (which may carry a leftover status from before they
-- became a coach) are excluded from the count so they never consume
-- capacity that a real Starter/Substitute needs. The bulk rebalance sets
-- fivestack.rebalancing so this stands aside.
CREATE OR REPLACE FUNCTION public.tbiu_team_roster_status() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _count int;
    _max int;
BEGIN
    IF current_setting('fivestack.rebalancing', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'Starter' AND NOT NEW.coach THEN
        _max := 5;
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Starter' AND NOT coach
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Substitute';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' starters are allowed; bench a starter first';
            END IF;
        END IF;
    END IF;

    IF NEW.status = 'Substitute' AND NOT NEW.coach THEN
        _max := public.team_max_subs();
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Substitute' AND NOT coach
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Benched';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' substitutes are allowed';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_team_roster_status ON public.team_roster;
CREATE TRIGGER tbiu_team_roster_status
    BEFORE INSERT OR UPDATE ON public.team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tbiu_team_roster_status();
