CREATE OR REPLACE FUNCTION public.delete_tournament_brackets_and_matches(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    tournament_matches uuid[];
BEGIN
   -- DEAFCS: a match with demos or clips is never deleted from here (the SQL
   -- delete cannot remove its files from storage). Cancelling keeps such
   -- matches linked; only deleting the tournament removes them and their
   -- files. Without this, the demo FK failed with a raw error and a match
   -- with only clips left its files behind.
   IF EXISTS (
       SELECT 1
       FROM tournament_brackets tb
       JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
       WHERE ts.tournament_id = _tournament_id
         AND tb.match_id IS NOT NULL
         AND (
             EXISTS (
                 SELECT 1 FROM match_map_demos d
                 WHERE d.match_id = tb.match_id
             )
             OR EXISTS (
                 SELECT 1 FROM match_clips c
                 JOIN match_maps mm ON mm.id = c.match_map_id
                 WHERE mm.match_id = tb.match_id
             )
         )
   ) THEN
       RAISE EXCEPTION 'This tournament has played matches with demos or clips, so its bracket cannot be rebuilt. Delete the tournament instead.' USING ERRCODE = '22000';
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
