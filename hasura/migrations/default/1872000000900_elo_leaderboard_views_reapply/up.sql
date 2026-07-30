-- Add explicit current and peak ELO leaderboard views while preserving all
-- existing non-ELO leaderboard behavior.
DROP FUNCTION IF EXISTS public.get_player_leaderboard_rank(TEXT, INT, TEXT, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS public.get_leaderboard(TEXT, INT, TEXT, BOOLEAN, TEXT, UUID);
DROP FUNCTION IF EXISTS public._leaderboard_elo(INT, TEXT, BOOLEAN, UUID);

CREATE OR REPLACE FUNCTION public._leaderboard_elo(
  _window_days INT,
  _match_type TEXT,
  _exclude_tournaments BOOLEAN,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  _from timestamptz;
  _to timestamptz;
  _use_peak boolean;
  _unbounded_current boolean;
BEGIN
  IF _elo_view IS NULL OR lower(_elo_view) NOT IN ('current', 'peak') THEN
    RAISE EXCEPTION 'Invalid ELO view: %. Must be one of: current, peak', _elo_view;
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

  IF _exclude_tournaments THEN
    RETURN QUERY
    WITH last_elo_raw AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id,
        pe.current as raw_current,
        pe.change as latest_change
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_season_id IS NULL OR pe.season_id = _season_id)
        AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
      ORDER BY pe.steam_id, pe.created_at DESC, pe.match_id DESC
    ),
    peak_elo AS (
      SELECT pe.steam_id, MAX(pe.current) as peak_current
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_season_id IS NULL OR pe.season_id = _season_id)
        AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
      GROUP BY pe.steam_id
    ),
    tournament_adj AS (
      SELECT pe.steam_id, SUM(pe.change) as tourney_total
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_season_id IS NULL OR pe.season_id = _season_id)
        AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
        AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
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
        AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
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
          AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id)
      ) sub
      GROUP BY sub.steam_id
    )
    SELECT
      le.steam_id::text          as player_steam_id,
      p.name                     as player_name,
      p.avatar_url               as player_avatar_url,
      p.country                  as player_country,
      CASE WHEN _use_peak
        THEN (pk_e.peak_current - COALESCE(ta.tourney_total, 0))::float
        ELSE (le.raw_current - COALESCE(ta.tourney_total, 0))::float
      END                        as value,
      CASE WHEN _use_peak
        THEN 0::float
        WHEN _unbounded_current
        THEN le.latest_change::float
        ELSE ((le.raw_current - COALESCE(ta.tourney_total, 0)) - fe.starting_elo)::float
      END                        as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      COALESCE(mc.matches_played, 0)::int as matches_played
    FROM last_elo_raw le
    JOIN peak_elo pk_e ON pk_e.steam_id = le.steam_id
    LEFT JOIN tournament_adj ta ON ta.steam_id = le.steam_id
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    LEFT JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    JOIN players p ON p.steam_id = le.steam_id
    ORDER BY value DESC;

  ELSE
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
    peak_elo AS (
      SELECT pe.steam_id, MAX(pe.current) as peak_current
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_season_id IS NULL OR pe.season_id = _season_id)
        AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
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
    )
    SELECT
      le.steam_id::text          as player_steam_id,
      p.name                     as player_name,
      p.avatar_url               as player_avatar_url,
      p.country                  as player_country,
      CASE WHEN _use_peak
        THEN pk_e.peak_current::float
        ELSE le.current_elo::float
      END                        as value,
      CASE WHEN _use_peak
        THEN 0::float
        WHEN _unbounded_current
        THEN le.latest_change::float
        ELSE (le.current_elo - fe.starting_elo)::float
      END                        as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      mc.matches_played::int     as matches_played
    FROM last_elo le
    JOIN peak_elo pk_e ON pk_e.steam_id = le.steam_id
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    JOIN players p ON p.steam_id = le.steam_id
    ORDER BY value DESC;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard(
  _category TEXT,
  _window_days INT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE,
  _role TEXT DEFAULT NULL,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current'
)
RETURNS SETOF public.leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  IF _category = 'elo' THEN
    RETURN QUERY SELECT * FROM _leaderboard_elo(_window_days, _match_type, _exclude_tournaments, _season_id, _elo_view);

  ELSIF _category = 'best_kdr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_kdr(_window_days, _match_type, _exclude_tournaments, _season_id);

  ELSIF _category = 'best_win_rate' THEN
    RETURN QUERY SELECT * FROM _leaderboard_win_rate(_window_days, _match_type, _exclude_tournaments, _season_id);

  ELSIF _category = 'highest_hs_pct' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hs_pct(_window_days, _match_type, _exclude_tournaments, _season_id);

  ELSIF _category = 'trophies' THEN
    RETURN QUERY SELECT * FROM _leaderboard_trophies(_window_days, _match_type, _season_id);

  ELSIF _category = 'best_rating' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('rating', _window_days, _match_type, _exclude_tournaments, _role, _season_id);

  ELSIF _category = 'best_adr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('adr', _window_days, _match_type, _exclude_tournaments, _role, _season_id);

  ELSIF _category = 'best_kpr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kpr', _window_days, _match_type, _exclude_tournaments, _role, _season_id);

  ELSIF _category = 'best_kast' THEN
    RETURN QUERY SELECT * FROM _leaderboard_hltv_metric('kast', _window_days, _match_type, _exclude_tournaments, _role, _season_id);

  ELSIF _category = 'best_udr' THEN
    RETURN QUERY SELECT * FROM _leaderboard_udr(_window_days, _match_type, _exclude_tournaments, _role, _season_id);

  ELSE
    RAISE EXCEPTION 'Invalid category: %. Must be one of: elo, best_kdr, best_win_rate, highest_hs_pct, trophies, best_rating, best_adr, best_kpr, best_kast, best_udr', _category;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_player_leaderboard_rank(
  _category TEXT,
  _window_days INT,
  _player_steam_id TEXT,
  _match_type TEXT DEFAULT NULL,
  _exclude_tournaments BOOLEAN DEFAULT FALSE,
  _season_id UUID DEFAULT NULL,
  _elo_view TEXT DEFAULT 'current'
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
    -- Pass all 7 args explicitly. A shorter call binds ambiguously if a stale
    -- overload still exists; exact arity always resolves the 7-arg one.
    FROM public.get_leaderboard(_category, _window_days, _match_type, _exclude_tournaments, NULL::text, _season_id, _elo_view) le
  )
  SELECT r.player_steam_id, r.value, r.rank, r.total
  FROM ranked r
  WHERE r.player_steam_id = _player_steam_id
  LIMIT 1;
END;
$$;
