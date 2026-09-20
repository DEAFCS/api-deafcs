CREATE OR REPLACE FUNCTION public.can_open_tournament_registration(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    has_stages boolean;
BEGIN
    IF tournament.status != 'Setup' AND tournament.status != 'RegistrationClosed' AND tournament.status != 'Cancelled' AND tournament.status != 'CancelledMinTeams' THEN
        RETURN false;
    END IF;

    IF tournament.start < now() THEN
        RETURN false;
    END IF;

    IF tournament_has_max_teams(tournament) THEN
        RETURN false;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
    ) INTO has_stages;

    IF NOT has_stages THEN
        RETURN false;
    END IF;
    
    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
