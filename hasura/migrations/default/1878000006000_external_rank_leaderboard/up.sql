-- Cached FACEIT match completion time. It is refreshed from the official
-- FACEIT Data API together with the existing rating and skill-level cache.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS faceit_last_match_at timestamptz;

-- Provenance describes where an imported match's started_at value came from.
-- Existing rows intentionally remain NULL: historical timestamps cannot be
-- proven after the fact and must not appear as Premier match dates.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS external_timestamp_source text;

ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_external_timestamp_source_check;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_external_timestamp_source_check
  CHECK (
    external_timestamp_source IS NULL
    OR external_timestamp_source IN (
      'steam_gc',
      'demo_cdn_last_modified',
      'faceit_api'
    )
  );

ALTER TABLE public.pending_match_imports
  ADD COLUMN IF NOT EXISTS match_timestamp_source text;

ALTER TABLE public.pending_match_imports
  DROP CONSTRAINT IF EXISTS pending_match_imports_timestamp_source_check;

ALTER TABLE public.pending_match_imports
  ADD CONSTRAINT pending_match_imports_timestamp_source_check
  CHECK (
    match_timestamp_source IS NULL
    OR match_timestamp_source IN ('steam_gc', 'demo_cdn_last_modified')
  );

COMMENT ON COLUMN public.players.faceit_last_match_at IS
  'Completion timestamp of the latest CS2 match returned by the official FACEIT Data API.';

COMMENT ON COLUMN public.matches.external_timestamp_source IS
  'Verified provenance for started_at on imported matches. NULL means the timestamp is not suitable for an external last-match claim.';

COMMENT ON COLUMN public.pending_match_imports.match_timestamp_source IS
  'Provenance carried from Steam match resolution into the imported match row.';

CREATE INDEX IF NOT EXISTS idx_players_verified_faceit_refresh
  ON public.players (faceit_updated_at ASC NULLS FIRST, steam_id ASC)
  WHERE role IN (
    'verified_user',
    'streamer',
    'moderator',
    'match_organizer',
    'tournament_organizer',
    'administrator'
  );

CREATE OR REPLACE VIEW public.external_rank_leaderboard AS
SELECT
  p.steam_id AS player_steam_id,
  p.name AS player_name,
  p.avatar_url AS player_avatar_url,
  p.custom_avatar_url AS player_custom_avatar_url,
  p.country AS player_country,
  p.faceit_elo,
  p.faceit_skill_level,
  p.faceit_nickname,
  p.faceit_url,
  p.faceit_last_match_at,
  CASE WHEN p.premier_rank > 0 THEN p.premier_rank ELSE NULL END AS premier_rank,
  premier.last_match_at AS premier_last_match_at
FROM public.players p
LEFT JOIN LATERAL (
  SELECT m.started_at AS last_match_at
  FROM public.player_premier_rank_history history
  JOIN public.matches m ON m.id = history.match_id
  JOIN public.match_options options ON options.id = m.match_options_id
  WHERE history.steam_id = p.steam_id
    AND history.rank_type = 11
    AND m.source = 'valve'
    AND m.status = 'Finished'
    AND options.type = 'Premier'
    AND m.external_timestamp_source = 'steam_gc'
    AND m.started_at IS NOT NULL
  ORDER BY m.started_at DESC, m.id DESC
  LIMIT 1
) premier ON true
WHERE p.role IN (
  'verified_user',
  'streamer',
  'moderator',
  'match_organizer',
  'tournament_organizer',
  'administrator'
);

COMMENT ON VIEW public.external_rank_leaderboard IS
  'Verified DEAFCS community players with cached FACEIT and Premier ratings. Premier dates require Steam GC timestamp provenance.';
