CREATE OR REPLACE FUNCTION public.can_start_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status NOT IN ('Setup', 'RegistrationOpen', 'RegistrationClosed') THEN
        RETURN false;
    END IF;

    IF NOT tournament_has_min_teams(tournament) THEN
        RETURN false;
    END IF;

    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
