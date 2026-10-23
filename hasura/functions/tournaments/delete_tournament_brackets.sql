CREATE OR REPLACE FUNCTION public.delete_tournament_brackets_and_matches(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    tournament_matches uuid[];
BEGIN
   -- DEAFCS: a played match (public.match_has_played_data: Live or a result,
   -- rounds, stats, demos or clips) is never deleted from here. Cancelling
   -- keeps such matches linked; only deleting the tournament removes them and
   -- their files. Without this, the delete below silently took their stats,
   -- demo rows (match_map_demos.match_id is ON DELETE CASCADE) and clip rows,
   -- and left every file behind in storage.
   IF EXISTS (
       SELECT 1
       FROM tournament_brackets tb
       JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
       WHERE ts.tournament_id = _tournament_id
         AND tb.match_id IS NOT NULL
         AND public.match_has_played_data(tb.match_id)
   ) THEN
       RAISE EXCEPTION 'This tournament has played matches, so its bracket cannot be rebuilt. Delete the tournament instead.' USING ERRCODE = '22000';
   END IF;

   DELETE FROM matches
   WHERE id IN (
       SELECT tb.match_id
       FROM tournament_brackets tb
       JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
       WHERE ts.tournament_id = _tournament_id
         AND tb.match_id IS NOT NULL
   );

   DELETE FROM tournament_brackets
   WHERE tournament_stage_id IN (
       SELECT ts.id
       FROM tournament_stages ts
       WHERE ts.tournament_id = _tournament_id
   );
END;
$$ LANGUAGE plpgsql;
