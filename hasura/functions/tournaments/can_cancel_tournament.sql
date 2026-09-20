CREATE OR REPLACE FUNCTION public.can_cancel_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status = 'Cancelled' OR tournament.status = 'CancelledMinTeams' OR tournament.status = 'Finished' THEN
        return false;
    END IF;

    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
