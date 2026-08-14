DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
drop function if exists public.tbi_match_lineup_players;

CREATE OR REPLACE FUNCTION public.resolve_match_lineup_roster_image_snapshot(
    _match_lineup_id uuid,
    _steam_id bigint
) RETURNS text
    LANGUAGE sql
    STABLE
    AS $$
    SELECT ttr.roster_image_url_snapshot
      FROM public.match_lineups ml
      INNER JOIN public.matches m ON m.id = ml.match_id
      INNER JOIN public.tournament_brackets tb ON tb.match_id = m.id
      INNER JOIN public.tournament_team_roster ttr
        ON ttr.tournament_team_id = CASE
             WHEN m.lineup_1_id = ml.id THEN tb.tournament_team_id_1
             WHEN m.lineup_2_id = ml.id THEN tb.tournament_team_id_2
           END
       AND ttr.player_steam_id = _steam_id
     WHERE ml.id = _match_lineup_id
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.tbiu_match_lineup_players_roster_snapshot() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _status text;
BEGIN
    IF TG_OP = 'INSERT'
       OR NEW.steam_id IS DISTINCT FROM OLD.steam_id
       OR NEW.match_lineup_id IS DISTINCT FROM OLD.match_lineup_id THEN
        SELECT m.status
          INTO _status
          FROM public.match_lineups ml
          INNER JOIN public.matches m ON m.id = ml.match_id
         WHERE ml.id = NEW.match_lineup_id;

        IF TG_OP = 'INSERT'
           OR _status IN (
               'PickingPlayers',
               'Scheduled',
               'WaitingForCheckIn',
               'Veto',
               'WaitingForServer',
               'Canceled'
           ) THEN
            NEW.roster_image_url_snapshot :=
                public.resolve_match_lineup_roster_image_snapshot(
                    NEW.match_lineup_id,
                    NEW.steam_id
                );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_match_lineup_players_roster_snapshot ON public.match_lineup_players;
CREATE TRIGGER tbiu_match_lineup_players_roster_snapshot
    BEFORE INSERT OR UPDATE OF steam_id, match_lineup_id
    ON public.match_lineup_players
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_match_lineup_players_roster_snapshot();

CREATE OR REPLACE FUNCTION public.tbu_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.captain = true AND NEW.match_lineup_id != OLD.match_lineup_id THEN
        NEW.captain = false;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbu_match_lineup_players BEFORE UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tau_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
     IF NEW.captain = true THEN
        UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
    END IF;

    PERFORM pick_captain(NEW.match_lineup_id);
    PERFORM pick_captain(OLD.match_lineup_id);

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tau_match_lineup_players AFTER UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tau_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tbid_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
    match_type text;
    is_tournament boolean;
    is_draft boolean;
    sanction_only boolean;
    lineup_count INT;
    _max_players_per_lineup INT;
BEGIN
    SELECT mo.type, m.status, COALESCE(is_tournament_match(m), false), COALESCE(is_draft_match(m), false)
        INTO match_type, status, is_tournament, is_draft
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE ml.id = COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);

    sanction_only := is_tournament OR is_draft;

    IF TG_OP = 'INSERT' THEN
        -- Tournament and draft matches only care about a real admin
        -- sanction, not an automatic leaver/no-show ban ("Abandoned") --
        -- MM keeps blocking on any active ban, same as before.
        IF (
            (sanction_only AND is_admin_sanctioned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
            OR (NOT sanction_only AND is_banned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
        ) THEN
            RAISE EXCEPTION 'Player is Currently Banned' USING ERRCODE = '22000';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        SELECT COUNT(*) INTO lineup_count
            FROM match_lineup_players
            WHERE match_lineup_id = OLD.match_lineup_id;

        IF ((status != 'PickingPlayers' AND status != 'Canceled') AND (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text != 'admin') THEN
            SELECT get_match_type_min_players(match_type) INTO _max_players_per_lineup;

            IF (lineup_count - 1) >= _max_players_per_lineup THEN
                RETURN OLD;
            END IF;

            RAISE EXCEPTION 'Cannot remove players: not enough players in lineup' USING ERRCODE = '22000';
        END IF;

        RETURN OLD;
    ELSE
        select check_match_lineup_players_count(NEW) into lineup_count;

        IF lineup_count = 0 THEN
            NEW.captain = true;
        END IF;

        PERFORM check_match_lineup_players(NEW);

        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS tbid_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbid_match_lineup_players BEFORE INSERT OR DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbid_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tad_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    captain_count INT;
    new_captain_id bigint;
BEGIN
    PERFORM pick_captain(OLD.match_lineup_id);

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tad_match_lineup_players AFTER DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tad_match_lineup_players();

CREATE OR REPLACE FUNCTION public.tai_match_lineup_players_parties() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_match_id uuid;
BEGIN
    FOR v_match_id IN
        SELECT DISTINCT ml.match_id
          FROM new_rows nr
          JOIN public.match_lineups ml ON ml.id = nr.match_lineup_id
         WHERE ml.match_id IS NOT NULL
    LOOP
        PERFORM public.assign_lobby_parties(v_match_id);
    END LOOP;

    RETURN NULL;
END;
$$;

-- Statement level, not per row: assign_lobby_parties asks whether anyone else
-- from the lobby is in this match, which is never true on the first row of a
-- bulk insert.
DROP TRIGGER IF EXISTS tai_match_lineup_players_parties ON public.match_lineup_players;
CREATE TRIGGER tai_match_lineup_players_parties
    AFTER INSERT ON public.match_lineup_players
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.tai_match_lineup_players_parties();
