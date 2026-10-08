-- Carries a tournament team's current roster and captain into every match of
-- that team that exists but has not started.
--
-- Only Scheduled and WaitingForCheckIn matches are touched. Anything underway
-- (PickingPlayers, Veto, WaitingForServer, Live), finished or canceled keeps
-- its lineup and its roster snapshots exactly as played. A team below the
-- starting size is skipped: it is ineligible, and a lineup cannot shrink under
-- the minimum. The refresh itself keeps the captain, never duplicates a seat,
-- re-seats rows in place and clears the check-in of a re-seated row.
CREATE OR REPLACE FUNCTION public.refresh_unstarted_tournament_team_lineups(_tournament_team_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _roster_count int;
    _bracket public.tournament_brackets;
BEGIN
    SELECT t.* INTO _tournament
      FROM public.tournament_teams tt
      INNER JOIN public.tournaments t ON t.id = tt.tournament_id
     WHERE tt.id = _tournament_team_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT COUNT(*) INTO _roster_count
      FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_team_id = _tournament_team_id;

    IF _roster_count < public.tournament_min_players_per_lineup(_tournament) THEN
        RETURN;
    END IF;

    FOR _bracket IN
        SELECT tb.*
          FROM public.tournament_brackets tb
          INNER JOIN public.matches m ON m.id = tb.match_id
         WHERE tb.match_id IS NOT NULL
           AND (tb.tournament_team_id_1 = _tournament_team_id
                OR tb.tournament_team_id_2 = _tournament_team_id)
           AND m.status IN ('Scheduled', 'WaitingForCheckIn')
    LOOP
        PERFORM public.refresh_tournament_match_lineup_teams(_bracket);
    END LOOP;
END;
$$;
