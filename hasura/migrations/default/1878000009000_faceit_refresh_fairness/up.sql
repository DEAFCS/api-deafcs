-- Keep scheduling attempts separate from successful FACEIT synchronization.
-- Failed and cached no-account attempts advance this timestamp without
-- changing faceit_updated_at or any valid cached rating data.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS faceit_refresh_attempted_at timestamptz;

COMMENT ON COLUMN public.players.faceit_refresh_attempted_at IS
  'Most recent background FACEIT leaderboard refresh attempt, whether successful or failed.';

CREATE INDEX IF NOT EXISTS idx_players_verified_faceit_refresh_attempt
  ON public.players (
    faceit_refresh_attempted_at ASC NULLS FIRST,
    faceit_updated_at ASC NULLS FIRST,
    steam_id ASC
  )
  WHERE role IN (
    'verified_user',
    'streamer',
    'moderator',
    'match_organizer',
    'tournament_organizer',
    'administrator'
  );
