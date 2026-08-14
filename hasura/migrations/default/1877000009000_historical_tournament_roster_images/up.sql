ALTER TABLE public.tournament_team_roster
    ADD COLUMN IF NOT EXISTS roster_image_url_snapshot text NULL;

ALTER TABLE public.match_lineup_players
    ADD COLUMN IF NOT EXISTS roster_image_url_snapshot text NULL;

-- Match-lineup trigger definitions are canonicalized below. The legacy
-- tbi_match_lineup_players trigger is intentionally removed by the current
-- trigger source and must not remain alongside the snapshot trigger.
DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
DROP FUNCTION IF EXISTS public.tbi_match_lineup_players();

CREATE OR REPLACE FUNCTION public.resolve_tournament_roster_image_snapshot(
    _tournament_team_id uuid,
    _player_steam_id bigint
) RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    AS $$
DECLARE
    _team_id uuid;
    _team_roster_image text;
    _player_roster_image text;
BEGIN
    SELECT tt.team_id INTO _team_id
      FROM public.tournament_teams tt
     WHERE tt.id = _tournament_team_id;

    SELECT p.roster_image_url INTO _player_roster_image
      FROM public.players p
     WHERE p.steam_id = _player_steam_id
     FOR SHARE;

    IF _team_id IS NOT NULL THEN
        SELECT tr.roster_image_url INTO _team_roster_image
          FROM public.team_roster tr
         WHERE tr.team_id = _team_id
           AND tr.player_steam_id = _player_steam_id
         FOR SHARE;
    END IF;

    RETURN COALESCE(_team_roster_image, _player_roster_image);
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_tournament_roster_image_snapshots(
    _tournament_id uuid
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _roster RECORD;
BEGIN
    FOR _roster IN
        SELECT ttr.tournament_team_id, ttr.player_steam_id
          FROM public.tournament_team_roster ttr
         WHERE ttr.tournament_id = _tournament_id
           AND ttr.roster_image_url_snapshot IS NULL
         ORDER BY ttr.tournament_team_id, ttr.player_steam_id
         FOR UPDATE
    LOOP
        UPDATE public.tournament_team_roster ttr
           SET roster_image_url_snapshot =
               public.resolve_tournament_roster_image_snapshot(
                   _roster.tournament_team_id,
                   _roster.player_steam_id
               )
         WHERE ttr.tournament_id = _tournament_id
           AND ttr.tournament_team_id = _roster.tournament_team_id
           AND ttr.player_steam_id = _roster.player_steam_id
           AND ttr.roster_image_url_snapshot IS NULL;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_tournament_roster_image_snapshots(
    _tournament_id uuid
) RETURNS void
    LANGUAGE sql
    AS $$
    UPDATE public.tournament_team_roster
       SET roster_image_url_snapshot = NULL
     WHERE tournament_id = _tournament_id;
$$;

CREATE OR REPLACE FUNCTION public.tbi_tournament_team_roster_snapshot() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _status text;
BEGIN
    SELECT t.status INTO _status
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

CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM check_team_eligibility(OLD);
    ELSE
        PERFORM check_team_eligibility(NEW);
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

DROP TRIGGER IF EXISTS tbi_tournament_team_roster_snapshot ON public.tournament_team_roster;
CREATE TRIGGER tbi_tournament_team_roster_snapshot
    BEFORE INSERT ON public.tournament_team_roster
    FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_roster_snapshot();

CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    first_stage_id uuid;
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status IN ('Setup', 'RegistrationOpen') THEN
            PERFORM public.clear_tournament_roster_image_snapshots(NEW.id);
        ELSIF NEW.status IN ('Live', 'RegistrationClosed')
              AND OLD.status IN ('Setup', 'RegistrationOpen') THEN
            PERFORM public.capture_tournament_roster_image_snapshots(NEW.id);
        END IF;
    END IF;

    IF (
         NEW.status IS DISTINCT FROM OLD.status AND
         NEW.status IN ('RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        return NEW;
    END IF;

    IF (
         NEW.status IS DISTINCT FROM OLD.status AND
         NEW.status IN ('Live', 'RegistrationClosed') AND
         OLD.status IN ('Setup', 'RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        PERFORM assign_seeds_to_teams(NEW);

        SELECT id INTO first_stage_id
        FROM tournament_stages
        WHERE tournament_id = NEW.id AND "order" = 1
        LIMIT 1;

        IF first_stage_id IS NOT NULL THEN
            PERFORM seed_stage(first_stage_id);
        END IF;
    END IF;

    IF (
         NEW.status IS DISTINCT FROM OLD.status AND
         OLD.status = 'Paused' AND NEW.status = 'Live'
         AND NEW.auto_start
    ) THEN
        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.bye = false
              AND ((tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NULL)
                OR (tb.tournament_team_id_1 IS NULL AND tb.tournament_team_id_2 IS NOT NULL))
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM resolve_bracket_bye(bracket_row);
        END LOOP;

        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.tournament_team_id_1 IS NOT NULL
              AND tb.tournament_team_id_2 IS NOT NULL
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM schedule_tournament_match(bracket_row);
        END LOOP;

        PERFORM calculate_tournament_bracket_start_times(NEW.id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();

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
        SELECT m.status INTO _status
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
