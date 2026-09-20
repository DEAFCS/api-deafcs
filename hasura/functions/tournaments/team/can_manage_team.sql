CREATE OR REPLACE FUNCTION public.can_manage_tournament_team(tournament_team public.tournament_teams, hasura_session json) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _user_steam_id bigint;
    _tournament public.tournaments;
BEGIN

    IF hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator') THEN
        RETURN true;
    END IF;

    _user_steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    IF _user_steam_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = tournament_team.tournament_id;

    IF FOUND AND public.is_tournament_organizer(_tournament, hasura_session) THEN
        RETURN true;
    END IF;

    IF tournament_team.owner_steam_id = _user_steam_id THEN
        RETURN true;
    END IF;

    IF EXISTS (
        SELECT 1 FROM tournament_team_roster
        WHERE tournament_team_id = tournament_team.id
          AND player_steam_id = _user_steam_id
          AND role IN ('Admin')
    ) THEN
        RETURN true;
    END IF;

    IF tournament_team.team_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM teams
            WHERE id = tournament_team.team_id
              AND (
                  owner_steam_id = _user_steam_id
                  OR captain_steam_id = _user_steam_id
              )
        ) OR EXISTS (
            SELECT 1 FROM team_roster
            WHERE team_id = tournament_team.team_id
              AND player_steam_id = _user_steam_id
              AND role IN ('Admin')
        );
    END IF;

    RETURN false;
END;
$$;
