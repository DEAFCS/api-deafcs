CREATE OR REPLACE FUNCTION public.can_close_tournament_registration(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'RegistrationOpen' THEN
        RETURN false;
    END IF;

    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
