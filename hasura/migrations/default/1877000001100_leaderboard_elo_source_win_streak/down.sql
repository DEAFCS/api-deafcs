-- Rollback 1877000001100: restores _leaderboard_elo to the pre-win-streak-
-- scoping version (tertiary_value always the unfiltered win_streak CTE,
-- regardless of _source). No signature/arity change either direction, so
-- this is a plain CREATE OR REPLACE, no DROP FUNCTION needed.

-- Stale-overload cleanup. CREATE OR REPLACE cannot remove an old overload, so
-- once a second signature exists EVERY call becomes ambiguous ("function is not
-- unique", SQLSTATE 42725). Drop every known signature explicitly before
-- recreating so re-applying this file always lands on exactly one
-- get_leaderboard. Editing these lines also bumps the file hash, which forces
-- hasura.service's apply step (it skips files whose hash is unchanged) to
-- actually re-run this cleanup against an already-broken database.
DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT);
DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT, TEXT);                     -- pre-_season 2-arg
DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT, TEXT, UUID);               -- pre-_source 3-arg
DROP FUNCTION IF EXISTS public._leaderboard_awards(INT, TEXT, UUID);                 -- Phase A pre-compatibility name
DROP FUNCTION IF EXISTS public.get_leaderboard(TEXT, INT, TEXT, BOOLEAN);            -- pre-_role 4-arg
DROP FUNCTION IF EXISTS public.get_leaderboard(TEXT, INT, TEXT, BOOLEAN, TEXT);      -- pre-_season 5-arg
DROP FUNCTION IF EXISTS public.get_player_leaderboard_rank(TEXT, INT, TEXT, TEXT, BOOLEAN); -- pre-_season 5-arg
DROP FUNCTION IF EXISTS public._leaderboard_elo(INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_elo(INT, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS public._leaderboard_elo(INT, TEXT, BOOLEAN, UUID, TEXT);     -- pre-_source 5-arg
DROP FUNCTION IF EXISTS public._leaderboard_kdr(INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_kdr(INT, TEXT, BOOLEAN, UUID);           -- pre-_source 4-arg
DROP FUNCTION IF EXISTS public._leaderboard_win_rate(INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_win_rate(INT, TEXT, BOOLEAN, UUID);      -- pre-_source 4-arg
DROP FUNCTION IF EXISTS public._leaderboard_hs_pct(INT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public._leaderboard_hs_pct(INT, TEXT, BOOLEAN, UUID);        -- pre-_source 4-arg
DROP FUNCTION IF EXISTS public._leaderboard_hltv_metric(TEXT, INT, TEXT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public._leaderboard_udr(INT, TEXT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public._leaderboard_match_source(UUID);
DROP FUNCTION IF EXISTS public._leaderboard_tournament_source(UUID);

-- Belt-and-suspenders: sweep up any other historical get_leaderboard arity we
-- did not enumerate above (e.g. an even older 3-arg overload).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN (
        'get_leaderboard',
        '_leaderboard_hltv_metric',
        '_leaderboard_udr'
      )
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END $$;

-- ============================================================
-- Match/tournament source classification (Matchmaking / Tournament / League)
--
-- Classifies a match into exactly one of 'matchmaking' / 'tournament' /
-- 'league' using only existing relationships -- no schema changes, no new
-- columns. This is a read-only classification helper; it does not affect
-- the canonical ELO write path or any ELO value calculation.
--   'matchmaking' = no tournament_brackets row references this match
--   'tournament'  = bracket-linked, but the owning tournament is NOT
--                   league-backed
--   'league'      = bracket-linked, and the owning tournament IS
--                   league-backed (public.is_league_tournament())
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_match_source(_match_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN tb.match_id IS NULL THEN 'matchmaking'
    WHEN public.is_league_tournament(ts.tournament_id) THEN 'league'
    ELSE 'tournament'
  END
  FROM (SELECT _match_id AS match_id) mm
  LEFT JOIN public.tournament_brackets tb ON tb.match_id = mm.match_id
  LEFT JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
$$;

-- Trophies join straight to tournaments (no match_id hop). Matchmaking is
-- not a meaningful bucket here -- trophies only ever exist for tournaments.
CREATE OR REPLACE FUNCTION public._leaderboard_tournament_source(_tournament_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN public.is_league_tournament(_tournament_id) THEN 'league'
    ELSE 'tournament'
  END
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard(
  _category TEXT,
  _window_days INT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE,
  _role TEXT DEFAULT NULL,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current',
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _category = 'elo' THEN
    RETURN QUERY SELECT * FROM _leaderboard_elo(_window_days, _match_type, _exclude_tournaments, _season_id, _elo_view, _source);

  ELSIF _category = 'best_kdr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_kdr(_window_days, _match_type, _exclude_tournaments, _season_id, _source);

  ELSIF _category = 'best_win_rate' THEN
    RETURN QUERY SELECT * FROM _leaderboard_win_rate(_window_days, _match_type, _exclude_tournaments, _season_id, _source);

  ELSIF _category = 'highest_hs_pct' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hs_pct(_window_days, _match_type, _exclude_tournaments, _season_id, _source);

  ELSIF _category = 'trophies' THEN
    RETURN QUERY SELECT * FROM _leaderboard_trophies(_window_days, _match_type, _season_id, _source);

  ELSIF _category = 'best_rating' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('rating', _window_days, _match_type, _exclude_tournaments, _role, _season_id, _source);

  ELSIF _category = 'best_adr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('adr', _window_days, _match_type, _exclude_tournaments, _role, _season_id, _source);

  ELSIF _category = 'best_kpr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kpr', _window_days, _match_type, _exclude_tournaments, _role, _season_id, _source);

  ELSIF _category = 'best_kast' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kast', _window_days, _match_type, _exclude_tournaments, _role, _season_id, _source);

  ELSIF _category = 'best_udr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_udr(_window_days, _match_type, _exclude_tournaments, _role, _season_id, _source);

  ELSE
    RAISE EXCEPTION 'Invalid category: %. Must be one of: elo, best_kdr, best_win_rate, highest_hs_pct, trophies, best_rating, best_adr, best_kpr, best_kast, best_udr', _category;
  END IF;
END;
$$;

-- ============================================================
-- ELO leaderboard
-- value = current ELO, secondary = ELO change, tertiary = win streak
--
-- CANONICAL ELO: there is exactly one ELO rating stream per
-- player + mode + configured ELO season, fed by every eligible source
-- (matchmaking, tournament, league) alike. The write path
-- (generate_player_elo_for_match, hasura/functions/match/match_player_elo.sql)
-- now always resolves the real season_id for a tournament/league match the
-- same way it does for a matchmaking match, so player_elo.current is a
-- single, directly-comparable number regardless of source -- there is no
-- more "regular ladder current" vs "tournament global current" split to
-- reconcile here.
--
-- _exclude_tournaments is intentionally NOT applied to ELO: filtering out
-- tournament-sourced rows and calling the remaining latest value "current
-- ELO" would be mathematically invalid, because later matchmaking/league
-- matches were already calculated on top of tournament-influenced ratings.
-- The parameter is still accepted (for call-signature compatibility with
-- the shared get_leaderboard dispatcher and the other, still source-
-- filterable, leaderboard categories below) but has no effect on ELO
-- value/secondary_value/tertiary_value/matches_played.
--
-- _source (Overall/Matchmaking/Tournament/League) is likewise NEVER applied
-- to `value`, for the exact same reason: there is only one canonical ELO
-- rating stream, and a source-filtered "current ELO" would be mathematically
-- invalid. _source instead scopes the *contribution* columns -- how much
-- ELO change and how many matches came from the selected source within the
-- window -- while `value` (current/peak) stays identical across every
-- Source selection for a given player/mode/window. When a Source other than
-- Overall is selected, players with zero matches from that source in the
-- window are dropped from the result set entirely (a clean empty state
-- rather than showing everyone with a fake all-zero row).
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_elo(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current',
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
  _use_peak boolean;
  _unbounded_current boolean;
  _is_rolling_window boolean;
  _active_named_season boolean;
  _peak_active_season_id uuid;
BEGIN
  IF _elo_view IS NULL OR lower(_elo_view) NOT IN ('current', 'peak') THEN
    RAISE EXCEPTION 'Invalid ELO view: %. Must be one of: current, peak', _elo_view;
  END IF;

  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  _use_peak := lower(_elo_view) = 'peak';
  IF _use_peak AND (_window_days <> 0 OR _season_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Peak ELO view only supports window_days = 0 without a season';
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  _unbounded_current := NOT _use_peak AND _season_id IS NULL AND _window_days = 0;
  -- Rolling windows (7/30 day, and any future positive window_days) report
  -- the SUM of every eligible match's own change inside the window.
  _is_rolling_window := NOT _use_peak AND _season_id IS NULL AND _window_days > 0;
  -- A named season is "active" when it's the season containing right now
  -- (open-ended, or ended_at still in the future) -- reusing the same
  -- definition public.get_active_season() already uses elsewhere.
  _active_named_season := _season_id IS NOT NULL AND _season_id IS NOT DISTINCT FROM public.get_active_season();

  -- All Time (Peak) additionally reports "Current ELO" alongside the
  -- historical peak: the player's canonical rating in whatever named
  -- season is active *right now*. NULL when there's currently no active
  -- season, in which case Current ELO falls back to its 5000 default.
  IF _use_peak THEN
    _peak_active_season_id := public.get_active_season();
  END IF;

  RETURN QUERY
  WITH last_elo AS (
    SELECT DISTINCT ON (pe.steam_id)
      pe.steam_id,
      pe.current as current_elo,
      pe.change as latest_change
    FROM player_elo pe
    WHERE 1=1
      AND (_match_type IS NULL OR pe.type = _match_type)
      AND (_season_id IS NULL OR pe.season_id = _season_id)
      AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
    ORDER BY pe.steam_id, pe.created_at DESC, pe.match_id DESC
  ),
  -- Peak: highest canonical rating a player has ever held for this type,
  -- across every source and every season -- unaffected by _exclude_tournaments.
  peak_elo AS (
    SELECT pe.steam_id, MAX(pe.current) as peak_current
    FROM player_elo pe
    WHERE 1=1
      AND (_match_type IS NULL OR pe.type = _match_type)
    GROUP BY pe.steam_id
  ),
  -- "Current ELO" shown alongside Peak/All Time: the player's canonical
  -- rating in whatever named season is active right now.
  peak_active_current AS (
    SELECT DISTINCT ON (pe.steam_id)
      pe.steam_id, pe.current AS active_current
    FROM player_elo pe
    WHERE _use_peak
      AND _peak_active_season_id IS NOT NULL
      AND pe.season_id = _peak_active_season_id
      AND (_match_type IS NULL OR pe.type = _match_type)
    ORDER BY pe.steam_id, pe.created_at DESC, pe.match_id DESC
  ),
  rolling_change AS (
    SELECT pe.steam_id, SUM(pe.change) as total_change
    FROM player_elo pe
    WHERE 1=1
      AND (_match_type IS NULL OR pe.type = _match_type)
      AND (_season_id IS NULL OR pe.season_id = _season_id)
      AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
    GROUP BY pe.steam_id
  ),
  -- Source-scoped contribution: how much ELO change and how many matches
  -- came from the selected Source within the window. Only computed/used
  -- when _source <> 'overall'. Never feeds `value` -- see the big comment
  -- above this function.
  source_change AS (
    SELECT pe.steam_id,
      SUM(pe.change) as total_change,
      COUNT(*)::int as source_matches_played
    FROM player_elo pe
    WHERE lower(_source) <> 'overall'
      AND (_match_type IS NULL OR pe.type = _match_type)
      AND (_season_id IS NULL OR pe.season_id = _season_id)
      AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
      AND public._leaderboard_match_source(pe.match_id) = lower(_source)
    GROUP BY pe.steam_id
  ),
  first_elo AS (
    SELECT DISTINCT ON (pe.steam_id)
      pe.steam_id,
      pe.current - pe.change as starting_elo
    FROM player_elo pe
    WHERE 1=1
      AND (_match_type IS NULL OR pe.type = _match_type)
      AND (_season_id IS NULL OR pe.season_id = _season_id)
      AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
    ORDER BY pe.steam_id, pe.created_at ASC, pe.match_id ASC
  ),
  match_counts AS (
    SELECT pe.steam_id, COUNT(*)::int as matches_played
    FROM player_elo pe
    WHERE 1=1
      AND (_match_type IS NULL OR pe.type = _match_type)
      AND (_season_id IS NULL OR pe.season_id = _season_id)
      AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
    GROUP BY pe.steam_id
  ),
  win_streak AS (
    SELECT sub.steam_id,
      COALESCE(MIN(CASE WHEN sub.won = 0 THEN sub.rn END) - 1, MAX(sub.rn))::int as streak
    FROM (
      SELECT
        mlp.steam_id,
        CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won,
        ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at DESC) as rn
      FROM match_lineup_players mlp
      JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
      JOIN matches m ON m.id = ml.match_id
      JOIN match_options mo ON mo.id = m.match_options_id
      WHERE m.status = 'Finished'
        AND m.source = '5stack'
        AND mlp.steam_id IS NOT NULL
        AND m.winning_lineup_id IS NOT NULL
        AND ((_from IS NULL OR m.ended_at >= _from) AND (_to IS NULL OR m.ended_at < _to))
        AND (_match_type IS NULL OR mo.type = _match_type)
    ) sub
    GROUP BY sub.steam_id
  ),
  record_streak AS (
    SELECT isl.steam_id, MAX(isl.island_len)::int AS record_streak
    FROM (
      SELECT sub.steam_id, (sub.overall_rn - sub.win_rn) AS grp, COUNT(*) AS island_len
      FROM (
        SELECT
          mlp.steam_id,
          ROW_NUMBER() OVER (PARTITION BY mlp.steam_id ORDER BY m.ended_at, m.id) AS overall_rn,
          ROW_NUMBER() OVER (
            PARTITION BY mlp.steam_id, (m.winning_lineup_id = mlp.match_lineup_id)
            ORDER BY m.ended_at, m.id
          ) AS win_rn,
          (m.winning_lineup_id = mlp.match_lineup_id) AS won
        FROM match_lineup_players mlp
        JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        JOIN matches m ON m.id = ml.match_id
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE _use_peak
          AND m.status = 'Finished'
          AND m.source = '5stack'
          AND mlp.steam_id IS NOT NULL
          AND m.winning_lineup_id IS NOT NULL
          AND (_match_type IS NULL OR mo.type = _match_type)
      ) sub
      WHERE sub.won
      GROUP BY sub.steam_id, (sub.overall_rn - sub.win_rn)
    ) isl
    GROUP BY isl.steam_id
  ),
  -- Driving row set: everyone last_elo already covers, unioned with anyone
  -- who only has a Peak-eligible row (peak_elo), so a Peak-view call still
  -- surfaces every player with ELO history for this type.
  driving_players AS (
    SELECT steam_id FROM last_elo
    UNION
    SELECT steam_id FROM peak_elo WHERE _use_peak
  ),
  -- When a Source other than Overall is selected, only keep players who
  -- actually have matches from that source in the window -- a clean empty
  -- leaderboard (or empty subset) rather than showing every canonical-ELO
  -- player with a fake all-zero row. `value` for anyone kept here is still
  -- untouched/canonical -- this only restricts *row membership*.
  filtered_players AS (
    SELECT d.steam_id
    FROM driving_players d
    WHERE lower(_source) = 'overall'
       OR EXISTS (SELECT 1 FROM source_change sc WHERE sc.steam_id = d.steam_id)
  )
  SELECT
    d.steam_id::text           as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    CASE WHEN _use_peak
      THEN pk.peak_current::float
      ELSE le.current_elo::float
    END                        as value,
    CASE WHEN _use_peak
      THEN COALESCE(pac.active_current, 5000)::float
      WHEN lower(_source) <> 'overall'
      THEN COALESCE(sc.total_change, 0)::float
      WHEN _unbounded_current
      THEN le.latest_change::float
      WHEN _is_rolling_window
      THEN COALESCE(rc.total_change, 0)::float
      WHEN _active_named_season
      THEN le.latest_change::float
      ELSE (le.current_elo - fe.starting_elo)::float
    END                        as secondary_value,
    CASE WHEN _use_peak
      THEN COALESCE(rs.record_streak, 0)::float
      ELSE COALESCE(ws.streak, 0)::float
    END                        as tertiary_value,
    CASE WHEN lower(_source) <> 'overall'
      THEN COALESCE(sc.source_matches_played, 0)
      ELSE COALESCE(mc.matches_played, 0)
    END::int                   as matches_played
  FROM filtered_players d
  LEFT JOIN last_elo le ON le.steam_id = d.steam_id
  LEFT JOIN peak_elo pk ON pk.steam_id = d.steam_id
  LEFT JOIN peak_active_current pac ON pac.steam_id = d.steam_id
  LEFT JOIN rolling_change rc ON rc.steam_id = d.steam_id
  LEFT JOIN source_change sc ON sc.steam_id = d.steam_id
  LEFT JOIN first_elo fe ON fe.steam_id = d.steam_id
  LEFT JOIN match_counts mc ON mc.steam_id = d.steam_id
  LEFT JOIN win_streak ws ON ws.steam_id = d.steam_id
  LEFT JOIN record_streak rs ON rs.steam_id = d.steam_id
  JOIN players p ON p.steam_id = d.steam_id
  WHERE (_use_peak AND pk.peak_current IS NOT NULL) OR (NOT _use_peak AND le.current_elo IS NOT NULL)
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- K/D Ratio leaderboard
-- value = K/D ratio, secondary = kills, tertiary = deaths
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_kdr(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  WITH kills AS (
    SELECT
      pk.attacker_steam_id as steam_id,
      COUNT(*) as kill_count,
      COUNT(DISTINCT pk.match_id)::int as match_count
    FROM player_kills pk
    JOIN matches m ON m.id = pk.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id != pk.attacked_steam_id
      AND m.source = '5stack'
      AND ((_from IS NULL OR pk.time >= _from) AND (_to IS NULL OR pk.time < _to))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pk.match_id))
      AND (lower(_source) = 'overall' OR public._leaderboard_match_source(pk.match_id) = lower(_source))
    GROUP BY pk.attacker_steam_id
  ),
  deaths AS (
    SELECT
      dk.attacked_steam_id as steam_id,
      COUNT(*) as death_count
    FROM player_kills dk
    JOIN matches m2 ON m2.id = dk.match_id
    JOIN match_options mo2 ON mo2.id = m2.match_options_id
    WHERE 1=1
      AND m2.source = '5stack'
      AND ((_from IS NULL OR dk.time >= _from) AND (_to IS NULL OR dk.time < _to))
      AND (_match_type IS NULL OR mo2.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = dk.match_id))
      AND (lower(_source) = 'overall' OR public._leaderboard_match_source(dk.match_id) = lower(_source))
    GROUP BY dk.attacked_steam_id
  )
  SELECT
    k.steam_id::text           as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    CASE WHEN COALESCE(d.death_count, 0) = 0
      THEN k.kill_count::float
      ELSE ROUND((k.kill_count::numeric / d.death_count::numeric), 2)::float
    END                        as value,
    k.kill_count::float        as secondary_value,
    COALESCE(d.death_count, 0)::float as tertiary_value,
    k.match_count              as matches_played
  FROM kills k
  LEFT JOIN deaths d ON d.steam_id = k.steam_id
  JOIN players p ON p.steam_id = k.steam_id
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Win Rate leaderboard
-- value = win%, secondary = wins, tertiary = losses
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_win_rate(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  WITH player_matches AS (
    SELECT
      mlp.steam_id,
      m.id as match_id,
      CASE WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 1 ELSE 0 END as won
    FROM match_lineup_players mlp
    JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    JOIN matches m ON m.id = ml.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.status = 'Finished'
      AND m.source = '5stack'
      AND mlp.steam_id IS NOT NULL
      AND m.winning_lineup_id IS NOT NULL
      AND ((_from IS NULL OR m.ended_at >= _from) AND (_to IS NULL OR m.ended_at < _to))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id))
      AND (lower(_source) = 'overall' OR public._leaderboard_match_source(m.id) = lower(_source))
  )
  SELECT
    pm.steam_id::text          as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    ROUND((SUM(pm.won)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
    SUM(pm.won)::float         as secondary_value,
    (COUNT(*) - SUM(pm.won))::float as tertiary_value,
    COUNT(*)::int              as matches_played
  FROM player_matches pm
  JOIN players p ON p.steam_id = pm.steam_id
  GROUP BY pm.steam_id, p.name, p.avatar_url, p.country
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Headshot % leaderboard
-- value = HS%, secondary = total kills, tertiary = null
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_hs_pct(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  SELECT
    pk.attacker_steam_id::text as player_steam_id,
    p.name                     as player_name,
    p.avatar_url               as player_avatar_url,
    p.country                  as player_country,
    ROUND((SUM(CASE WHEN pk.headshot THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric) * 100, 2)::float as value,
    COUNT(*)::float            as secondary_value,
    NULL::float                as tertiary_value,
    COUNT(DISTINCT pk.match_id)::int as matches_played
  FROM player_kills pk
  JOIN players p ON p.steam_id = pk.attacker_steam_id
  JOIN matches m ON m.id = pk.match_id
  JOIN match_options mo ON mo.id = m.match_options_id
  WHERE pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id != pk.attacked_steam_id
    AND m.source = '5stack'
    AND ((_from IS NULL OR pk.time >= _from) AND (_to IS NULL OR pk.time < _to))
    AND (_match_type IS NULL OR mo.type = _match_type)
    AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pk.match_id))
    AND (lower(_source) = 'overall' OR public._leaderboard_match_source(pk.match_id) = lower(_source))
  GROUP BY pk.attacker_steam_id, p.name, p.avatar_url, p.country
  ORDER BY value DESC;
END;
$$;

-- ============================================================
-- Trophies leaderboard
-- value = gold count, secondary = silver count, tertiary = bronze count
-- matches_played = total trophies. Olympic medal-table ordering.
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_trophies(
  _window_days INT,
  _match_type TEXT DEFAULT NULL,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  WITH counts AS (
    SELECT
      tt.player_steam_id,
      SUM(CASE WHEN tt.placement = 0 THEN 1 ELSE 0 END)::int as mvp,
      SUM(CASE WHEN tt.placement = 1 THEN 1 ELSE 0 END)::int as gold,
      SUM(CASE WHEN tt.placement = 2 THEN 1 ELSE 0 END)::int as silver,
      SUM(CASE WHEN tt.placement = 3 THEN 1 ELSE 0 END)::int as bronze,
      COUNT(*)::int as total
    FROM tournament_trophies tt
    JOIN tournaments t ON t.id = tt.tournament_id
    JOIN match_options mo ON mo.id = t.match_options_id
    WHERE tt.player_steam_id IS NOT NULL
      AND ((_from IS NULL OR t.start >= _from) AND (_to IS NULL OR t.start < _to))
      AND (_match_type IS NULL OR mo.type = _match_type)
      -- Trophies only ever belong to tournaments -- Matchmaking is never a
      -- meaningful bucket here and correctly yields an empty result.
      AND (
        lower(_source) = 'overall'
        OR (lower(_source) <> 'matchmaking' AND public._leaderboard_tournament_source(t.id) = lower(_source))
      )
    GROUP BY tt.player_steam_id
  )
  SELECT
    c.player_steam_id::text   as player_steam_id,
    p.name                    as player_name,
    p.avatar_url              as player_avatar_url,
    p.country                 as player_country,
    c.gold::float             as value,
    c.silver::float           as secondary_value,
    c.bronze::float           as tertiary_value,
    c.mvp                     as matches_played
  FROM counts c
  JOIN players p ON p.steam_id = c.player_steam_id
  WHERE c.total > 0
  ORDER BY c.mvp DESC, c.gold DESC, c.silver DESC, c.bronze DESC;
END;
$$;

CREATE TABLE IF NOT EXISTS public.player_leaderboard_rank (
  player_steam_id TEXT NOT NULL,
  value FLOAT NOT NULL DEFAULT 0,
  rank INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0
);

-- Drop every stale overload so the get_leaderboard() call below resolves
-- unambiguously. The current get_leaderboard / get_player_leaderboard_rank both
-- take 8 args (added _source), so anything with a different arg count is a
-- stale signature.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('get_leaderboard', 'get_player_leaderboard_rank')
      AND p.pronargs <> 8
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_player_leaderboard_rank(
  _category TEXT,
  _window_days INT,
  _player_steam_id TEXT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current',
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.player_leaderboard_rank
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH ranked AS (
    SELECT
      le.player_steam_id,
      le.value,
      (RANK() OVER (ORDER BY le.value DESC))::int AS rank,
      (COUNT(*) OVER ())::int AS total
    -- Pass all 8 args explicitly. A shorter call binds ambiguously if a stale
    -- overload still exists; exact arity always resolves the 8-arg one.
    FROM public.get_leaderboard(_category, _window_days, _match_type, _exclude_tournaments, NULL::text, _season_id, _elo_view, _source) le
  )
  SELECT r.player_steam_id, r.value, r.rank, r.total
  FROM ranked r
  WHERE r.player_steam_id = _player_steam_id
  LIMIT 1;
END;
$$;

-- ============================================================
-- HLTV-stat leaderboards (rating / ADR / KPR / KAST), rounds-weighted
-- value = _metric, secondary = complementary stat, tertiary = rounds played
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_hltv_metric(
  _metric TEXT,
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _role TEXT DEFAULT NULL,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      h.steam_id,
      SUM(h.hltv_rating * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0) AS rating,
      SUM(h.adr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS adr,
      SUM(h.kpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS kpr,
      SUM(h.dpr * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)         AS dpr,
      SUM(h.kast_pct * h.rounds_played) / NULLIF(SUM(h.rounds_played), 0)    AS kast,
      SUM(h.rounds_played)                                                   AS rounds,
      COUNT(DISTINCT h.match_id)::int                                        AS match_count
    FROM v_player_match_map_hltv h
    JOIN matches m ON m.id = h.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN v_player_match_map_roles r
      ON _role IS NOT NULL
     AND r.match_map_id = h.match_map_id
     AND r.steam_id = h.steam_id
    WHERE m.source = '5stack'
      AND ((_from IS NULL OR m.created_at >= _from) AND (_to IS NULL OR m.created_at < _to))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = h.match_id))
      AND (lower(_source) = 'overall' OR public._leaderboard_match_source(h.match_id) = lower(_source))
      AND (_role IS NULL OR r.role = _role)
    GROUP BY h.steam_id
    HAVING SUM(h.rounds_played) >= 50
  )
  SELECT
    a.steam_id::text   AS player_steam_id,
    p.name             AS player_name,
    p.avatar_url       AS player_avatar_url,
    p.country          AS player_country,
    (CASE _metric
      WHEN 'rating' THEN ROUND(a.rating::numeric, 2)
      WHEN 'adr'    THEN ROUND(a.adr::numeric, 1)
      WHEN 'kpr'    THEN ROUND(a.kpr::numeric, 2)
      WHEN 'kast'   THEN ROUND(a.kast::numeric, 1)
    END)::float        AS value,
    (CASE _metric
      WHEN 'rating' THEN ROUND(a.adr::numeric, 1)
      WHEN 'adr'    THEN ROUND(a.rating::numeric, 2)
      WHEN 'kpr'    THEN ROUND(a.dpr::numeric, 2)
      WHEN 'kast'   THEN ROUND(a.rating::numeric, 2)
    END)::float        AS secondary_value,
    a.rounds::float    AS tertiary_value,
    a.match_count      AS matches_played
  FROM agg a
  JOIN players p ON p.steam_id = a.steam_id
  ORDER BY value DESC NULLS LAST;
END;
$$;

-- ============================================================
-- Utility-damage-per-round leaderboard
-- value = UDR, secondary = total utility damage, tertiary = rounds played
-- ============================================================
CREATE OR REPLACE FUNCTION public._leaderboard_udr(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _role TEXT DEFAULT NULL,
  _season_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'overall'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF _source IS NULL OR lower(_source) NOT IN ('overall', 'matchmaking', 'tournament', 'league') THEN
    RAISE EXCEPTION 'Invalid source: %. Must be one of: overall, matchmaking, tournament, league', _source;
  END IF;

  IF _season_id IS NOT NULL THEN
    SELECT s.starts_at, COALESCE(s.ends_at, now())
      INTO _from, _to
    FROM public.seasons s
    WHERE s.id = _season_id;
  ELSIF _window_days > 0 THEN
    _from := now() - make_interval(days => _window_days);
    _to := NULL;
  ELSE
    _from := NULL;
    _to := NULL;
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      s.steam_id,
      SUM(s.he_damage + s.molotov_damage)                                   AS util_damage,
      SUM(s.he_damage + s.molotov_damage)::numeric / NULLIF(SUM(s.rounds_played), 0) AS udr,
      SUM(s.rounds_played)                                                  AS rounds,
      COUNT(DISTINCT s.match_id)::int                                       AS match_count
    FROM player_match_map_stats s
    JOIN matches m ON m.id = s.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN v_player_match_map_roles r
      ON _role IS NOT NULL
     AND r.match_map_id = s.match_map_id
     AND r.steam_id = s.steam_id
    WHERE m.source = '5stack'
      AND ((_from IS NULL OR m.created_at >= _from) AND (_to IS NULL OR m.created_at < _to))
      AND (_match_type IS NULL OR mo.type = _match_type)
      AND (NOT _exclude_tournaments OR NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = s.match_id))
      AND (lower(_source) = 'overall' OR public._leaderboard_match_source(s.match_id) = lower(_source))
      AND (_role IS NULL OR r.role = _role)
    GROUP BY s.steam_id
    HAVING SUM(s.rounds_played) >= 50
  )
  SELECT
    a.steam_id::text          AS player_steam_id,
    p.name                    AS player_name,
    p.avatar_url              AS player_avatar_url,
    p.country                 AS player_country,
    ROUND(a.udr, 1)::float    AS value,
    a.util_damage::float      AS secondary_value,
    a.rounds::float           AS tertiary_value,
    a.match_count             AS matches_played
  FROM agg a
  JOIN players p ON p.steam_id = a.steam_id
  ORDER BY value DESC NULLS LAST;
END;
$$;
