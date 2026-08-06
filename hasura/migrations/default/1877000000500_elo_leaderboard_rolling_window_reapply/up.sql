-- Reapply _leaderboard_elo with the corrected rolling-window ELO Change
-- formula. The two prior migrations that defined this function
-- (1872000000800, 1872000000900) are already applied in production and
-- are version-gated, so editing their historical content has no effect
-- on a live database; this migration is the only way to ship the fix.
--
-- Bug: for a rolling window (7/30 day, window_days > 0, no season),
-- secondary_value was computed as "latest ELO minus the ELO immediately
-- before the window's first row." When a season reset to 5000 landed
-- inside the window, that baseline collapsed to the post-reset value,
-- silently dropping any pre-reset matches from the total (this is why
-- 7-day and 30-day ELO Change could read identical even though the
-- 30-day window covered an extra match).
--
-- Fix: for a rolling window, secondary_value is now the SUM of every
-- eligible player_elo.change row inside the window (tournament rows
-- filtered per the existing Exclude Tournaments toggle, same as
-- everywhere else in this function). Peak, unbounded Current, and
-- named-season behavior are unchanged.
--
-- Signature, return type, and all other leaderboard functions are
-- untouched; only this function's body changes.

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
  _is_rolling_window boolean;
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
  -- Rolling windows (7/30 day, and any future positive window_days) must
  -- report the SUM of every eligible match's change inside the window, not
  -- "latest ELO minus the ELO immediately before the window's first row."
  -- That baseline formula silently collapses to whatever happened right
  -- before the window's first match — including a mid-window season reset
  -- to 5000 — instead of the true rolling total. Named seasons, Peak/All
  -- Time, and unbounded Current are unaffected and keep their existing
  -- formulas below.
  _is_rolling_window := NOT _use_peak AND _season_id IS NULL AND _window_days > 0;

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
    -- Rolling-window ELO Change: the total of every eligible (non-tournament,
    -- since tournaments are excluded here) match's own change inside the
    -- window. Only used when _is_rolling_window is true; harmless to compute
    -- otherwise (unused by the CASE below for peak/unbounded/named-season
    -- calls).
    rolling_change AS (
      SELECT pe.steam_id, SUM(pe.change) as total_change
      FROM player_elo pe
      WHERE 1=1
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (_season_id IS NULL OR pe.season_id = _season_id)
        AND ((_from IS NULL OR pe.created_at >= _from) AND (_to IS NULL OR pe.created_at < _to))
        AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
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
        WHEN _is_rolling_window
        THEN COALESCE(rc.total_change, 0)::float
        ELSE ((le.raw_current - COALESCE(ta.tourney_total, 0)) - fe.starting_elo)::float
      END                        as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      COALESCE(mc.matches_played, 0)::int as matches_played
    FROM last_elo_raw le
    JOIN peak_elo pk_e ON pk_e.steam_id = le.steam_id
    LEFT JOIN tournament_adj ta ON ta.steam_id = le.steam_id
    LEFT JOIN rolling_change rc ON rc.steam_id = le.steam_id
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
    -- Rolling-window ELO Change: the total of every eligible match's own
    -- change inside the window, tournaments included (the toggle is off in
    -- this branch). Only used when _is_rolling_window is true; harmless to
    -- compute otherwise.
    rolling_change AS (
      SELECT pe.steam_id, SUM(pe.change) as total_change
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
        WHEN _is_rolling_window
        THEN COALESCE(rc.total_change, 0)::float
        ELSE (le.current_elo - fe.starting_elo)::float
      END                        as secondary_value,
      COALESCE(ws.streak, 0)::float as tertiary_value,
      mc.matches_played::int     as matches_played
    FROM last_elo le
    JOIN peak_elo pk_e ON pk_e.steam_id = le.steam_id
    LEFT JOIN rolling_change rc ON rc.steam_id = le.steam_id
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    JOIN players p ON p.steam_id = le.steam_id
    ORDER BY value DESC;
  END IF;
END;
$$;
