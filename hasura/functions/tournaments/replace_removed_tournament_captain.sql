-- When the player named as a tournament team's captain is removed from that
-- team's tournament roster, move the captaincy to someone who is still on it,
-- so the team never keeps naming a captain who is no longer a player.
--
-- The replacement is deterministic: an eligible roster Admin first, otherwise
-- the lowest steam id (the same fallback pick_captain uses for a match
-- lineup). Pending invites and players under an admin ban are not eligible.
-- If nobody eligible is left, no captain is invented and the team is left as
-- it is: the minimum-lineup guards decide whether such a removal is allowed.
--
-- Only tournament_teams.captain_steam_id changes. The permanent captain of the
-- team (teams.captain_steam_id) is never touched, and the matches that
-- already started keep their lineups: the captain update (and the roster
-- change itself) refresh unstarted lineups only.
CREATE OR REPLACE FUNCTION public.replace_removed_tournament_captain(
    _tournament_team_id uuid,
    _removed_steam_id bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _replacement bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM public.tournament_teams tt
         WHERE tt.id = _tournament_team_id
           AND tt.captain_steam_id = _removed_steam_id
    ) THEN
        RETURN;
    END IF;

    SELECT ttr.player_steam_id INTO _replacement
      FROM public.tournament_team_roster ttr
      INNER JOIN public.players p ON p.steam_id = ttr.player_steam_id
     WHERE ttr.tournament_team_id = _tournament_team_id
       AND ttr.player_steam_id <> _removed_steam_id
       AND ttr.role <> 'Invite'
       AND NOT public.is_admin_sanctioned(p)
     ORDER BY (ttr.role = 'Admin') DESC, ttr.player_steam_id
     LIMIT 1;

    IF _replacement IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.tournament_teams
       SET captain_steam_id = _replacement
     WHERE id = _tournament_team_id;
END;
$$;
