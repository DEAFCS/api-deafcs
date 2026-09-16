DROP INDEX IF EXISTS public.idx_players_verified_faceit_refresh_attempt;

ALTER TABLE public.players
  DROP COLUMN IF EXISTS faceit_refresh_attempted_at;
