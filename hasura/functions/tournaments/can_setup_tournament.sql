CREATE OR REPLACE FUNCTION public.can_setup_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'Cancelled' AND tournament.status != 'CancelledMinTeams' THEN
        RETURN false;
    END IF;

    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
