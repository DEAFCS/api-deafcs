DROP TRIGGER IF EXISTS tbiu_match_lineup_players_roster_snapshot ON public.match_lineup_players;
DROP FUNCTION IF EXISTS public.tbiu_match_lineup_players_roster_snapshot();
DROP FUNCTION IF EXISTS public.resolve_match_lineup_roster_image_snapshot(uuid, bigint);

DROP TRIGGER IF EXISTS tbi_tournament_team_roster_snapshot ON public.tournament_team_roster;
DROP FUNCTION IF EXISTS public.tbi_tournament_team_roster_snapshot();

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
    AFTER INSERT OR UPDATE OR DELETE
    ON public.tournament_team_roster
    FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    first_stage_id uuid;
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
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

CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();

DROP FUNCTION IF EXISTS public.clear_tournament_roster_image_snapshots(uuid);
DROP FUNCTION IF EXISTS public.capture_tournament_roster_image_snapshots(uuid);
DROP FUNCTION IF EXISTS public.resolve_tournament_roster_image_snapshot(uuid, bigint);

ALTER TABLE public.match_lineup_players
    DROP COLUMN IF EXISTS roster_image_url_snapshot;

ALTER TABLE public.tournament_team_roster
    DROP COLUMN IF EXISTS roster_image_url_snapshot;
