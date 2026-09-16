DROP VIEW IF EXISTS public.external_rank_leaderboard;
DROP INDEX IF EXISTS public.idx_players_verified_faceit_refresh;

ALTER TABLE public.pending_match_imports
  DROP CONSTRAINT IF EXISTS pending_match_imports_timestamp_source_check;
ALTER TABLE public.pending_match_imports
  DROP COLUMN IF EXISTS match_timestamp_source;

ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_external_timestamp_source_check;
ALTER TABLE public.matches
  DROP COLUMN IF EXISTS external_timestamp_source;

ALTER TABLE public.players
  DROP COLUMN IF EXISTS faceit_last_match_at;
