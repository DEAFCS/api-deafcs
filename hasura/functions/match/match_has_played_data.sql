-- DEAFCS: whether a match has been played or holds anything a delete would
-- lose: a result, statistics, demos or clips. Deleting a match takes its demo
-- and clip rows with it (match_map_demos.match_id is ON DELETE CASCADE) and
-- leaves their files in storage, so flows that delete matches in SQL (Reset
-- Tournament Match, deleting a league season) refuse a match this is true for.
-- Callers lock the matches and their maps first, so nothing lands between the
-- check and the delete.
CREATE OR REPLACE FUNCTION public.match_has_played_data(_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.matches m
        WHERE m.id = _match_id
          AND (
              m.status IN ('Live', 'Finished', 'Tie', 'Forfeit', 'Surrendered')
              OR m.winning_lineup_id IS NOT NULL
              OR m.started_at IS NOT NULL
              OR m.ended_at IS NOT NULL
          )
    )
    OR EXISTS (
        SELECT 1 FROM public.match_map_rounds r
        JOIN public.match_maps mm ON mm.id = r.match_map_id
        WHERE mm.match_id = _match_id
    )
    OR EXISTS (SELECT 1 FROM public.player_kills WHERE match_id = _match_id)
    OR EXISTS (SELECT 1 FROM public.player_damages WHERE match_id = _match_id)
    OR EXISTS (SELECT 1 FROM public.player_assists WHERE match_id = _match_id)
    OR EXISTS (SELECT 1 FROM public.player_utility WHERE match_id = _match_id)
    OR EXISTS (SELECT 1 FROM public.match_map_demos WHERE match_id = _match_id)
    OR EXISTS (
        SELECT 1 FROM public.match_clips c
        JOIN public.match_maps mm ON mm.id = c.match_map_id
        WHERE mm.match_id = _match_id
    );
$$;
