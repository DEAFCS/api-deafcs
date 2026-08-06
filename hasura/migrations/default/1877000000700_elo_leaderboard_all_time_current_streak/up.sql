-- Reapply _leaderboard_elo to give the All Time (Peak) ELO view its final
-- three columns: a true non-tournament-reconstructed Peak ELO (Exclude
-- Tournaments on), the active named season's Current ELO, and the
-- player's all-time Record Win Streak (longest historical consecutive
-- win run) -- replacing the placeholder 0 previously returned for
-- secondary_value and the current-streak value previously returned for
-- tertiary_value under Peak.
--
-- Peak ELO correction: the previous Exclude-Tournaments-on approximation
-- (MAX(player_elo.current) - SUM(tournament changes)) can both overstate
-- and understate the true non-tournament peak depending on when in the
-- timeline the tournament changes landed relative to the actual peak.
-- Replaced with a reconstruction that walks every non-tournament
-- player_elo row in chronological order and re-sums its own `change` on
-- top of a fresh 5000 baseline, partitioned by (steam_id, type,
-- season_id) so each season's reset to 5000 is preserved rather than
-- treated as a continuous carry-over from the previous season.
--
-- Current ELO reuses the exact formula the active-season leaderboard
-- already uses for its own `value` column (COALESCE(regular season
-- current, 5000) + SUM(eligible tournament changes in-season)), just
-- resolved via get_active_season() instead of the caller's _season_id
-- (Peak calls are never allowed to pass a season). A player with no
-- active-season activity returns the 5000 default.
--
-- Record Win Streak is a gaps-and-islands window-function query over the
-- same eligible-match universe (Finished, 5stack, non-null winner) and
-- deterministic (ended_at, id) ordering the existing current-streak CTE
-- already uses.
--
-- Exclude Tournaments now governs Peak ELO, Current ELO, Record Win
-- Streak, and Matches consistently: off includes eligible tournament
-- data in all four, on excludes it from all four.
--
-- Active-season tournament inclusion/Last Match, completed-season Final
-- ELO/ELO Change, rolling 7/30-day SUM(change), and unbounded Current are
-- unchanged -- none of the new logic can be reached by those calls.
--
-- Signature, return type, and every other leaderboard function are
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
  _active_named_season boolean;
  _peak_active_season_id uuid;
  _peak_active_from timestamptz;
  _peak_active_to timestamptz;
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
  -- A named season is "active" when it's the season containing right now
  -- (open-ended, or ended_at still in the future) -- reusing the same
  -- definition public.get_active_season() already uses elsewhere, rather
  -- than re-deriving starts_at/ends_at comparisons here. Only active
  -- seasons gain tournament-inclusive ELO/Last Match below; a completed
  -- season keeps its existing final-minus-starting secondary_value and
  -- regular-only value, unchanged.
  -- IS NOT DISTINCT FROM (rather than =) so this never evaluates to SQL
  -- NULL when there's currently no active season at all (get_active_season()
  -- returns NULL off-season); it always resolves to a real boolean.
  _active_named_season := _season_id IS NOT NULL AND _season_id IS NOT DISTINCT FROM public.get_active_season();

  -- All Time (Peak) additionally reports "Current ELO" alongside the
  -- historical peak: the player's rating in whatever named season is
  -- active *right now*, resolved independently of the _season_id parameter
  -- (which the guard above forces NULL for every Peak call -- Peak and a
  -- season can never be requested together). NULL when there's currently
  -- no active season; every CTE below that depends on it is guarded to
  -- become a harmless no-op in that case, leaving Current ELO at its 5000
  -- default via COALESCE.
  IF _use_peak THEN
    _peak_active_season_id := public.get_active_season();
    IF _peak_active_season_id IS NOT NULL THEN
      SELECT s.starts_at, COALESCE(s.ends_at, now())
        INTO _peak_active_from, _peak_active_to
      FROM public.seasons s
      WHERE s.id = _peak_active_season_id;
    END IF;
  END IF;

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
    -- All Time / Peak "true" non-tournament ELO trajectory: player_elo.current
    -- already reflects the mixed tournament+regular ladder cumulatively, so
    -- naively subtracting the lifetime tournament total from the raw peak
    -- (the old approximation) can both overstate and understate the real
    -- non-tournament peak depending on when in the timeline the tournament
    -- changes landed relative to the true peak. Reconstructed instead by
    -- walking every non-tournament row in chronological order and re-summing
    -- its own `change` on top of a fresh 5000 baseline -- the same baseline
    -- every ladder and every season already starts a player from (see
    -- match_player_elo.sql's _default_elo). Partitioned by (steam_id, type,
    -- season_id) so a season's reset to 5000 is preserved rather than
    -- treated as a continuous carry-over from the previous season, and so
    -- separate match-type ladders (Competitive/Wingman/Duel) never mix.
    -- NULL season_id rows (legacy pre-seasons play and any off-season
    -- activity) group together as one shared partition -- the closest
    -- reconstructable approximation, since the schema doesn't distinguish
    -- "legacy, continuous" from "off-season, reset-per-match" once seasons
    -- are enabled; both already default to the same 5000 baseline per row
    -- with no prior row in scope, so this never understates the reset.
    peak_no_tourney_walk AS (
      SELECT
        pe.steam_id,
        5000::float + SUM(pe.change) OVER (
          PARTITION BY pe.steam_id, pe.type, pe.season_id
          ORDER BY pe.created_at, pe.match_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS reconstructed_current
      FROM player_elo pe
      WHERE _use_peak
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
    ),
    peak_no_tourney AS (
      SELECT steam_id, MAX(reconstructed_current) AS peak_current
      FROM peak_no_tourney_walk
      GROUP BY steam_id
    ),
    -- All Time Current ELO: the active named season's regular-ladder current
    -- (5000 default with no activity this season), tournaments excluded
    -- entirely in this branch -- mirrors the active-season `value` formula
    -- below, resolved via get_active_season() instead of the caller's
    -- _season_id.
    peak_active_regular AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id, pe.current AS active_current
      FROM player_elo pe
      WHERE _use_peak
        AND _peak_active_season_id IS NOT NULL
        AND pe.season_id = _peak_active_season_id
        AND (_match_type IS NULL OR pe.type = _match_type)
      ORDER BY pe.steam_id, pe.created_at DESC, pe.match_id DESC
    ),
    -- All Time Record Win Streak: longest historical run of consecutive
    -- wins, tournaments excluded in this branch, via a gaps-and-islands
    -- window-function grouping over the same eligible-match universe (and
    -- the same deterministic ended_at/id ordering) the existing current-
    -- streak CTE already uses.
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
            AND NOT EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id)
        ) sub
        WHERE sub.won
        GROUP BY sub.steam_id, (sub.overall_rn - sub.win_rn)
      ) isl
      GROUP BY isl.steam_id
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
        THEN COALESCE(pnt.peak_current, 5000)::float
        ELSE (le.raw_current - COALESCE(ta.tourney_total, 0))::float
      END                        as value,
      CASE WHEN _use_peak
        THEN COALESCE(par.active_current, 5000)::float
        WHEN _unbounded_current
        THEN le.latest_change::float
        WHEN _is_rolling_window
        THEN COALESCE(rc.total_change, 0)::float
        -- Exclude Tournaments is on, so the season's eligible rows are
        -- already regular-only (tournament rows never carry this season's
        -- season_id, so they never reach last_elo_raw here) -- le.latest_change
        -- is already "the latest regular match's own change" for Last Match.
        WHEN _active_named_season
        THEN le.latest_change::float
        ELSE ((le.raw_current - COALESCE(ta.tourney_total, 0)) - fe.starting_elo)::float
      END                        as secondary_value,
      CASE WHEN _use_peak
        THEN COALESCE(rs.record_streak, 0)::float
        ELSE COALESCE(ws.streak, 0)::float
      END                        as tertiary_value,
      COALESCE(mc.matches_played, 0)::int as matches_played
    FROM last_elo_raw le
    LEFT JOIN tournament_adj ta ON ta.steam_id = le.steam_id
    LEFT JOIN rolling_change rc ON rc.steam_id = le.steam_id
    JOIN first_elo fe ON fe.steam_id = le.steam_id
    LEFT JOIN match_counts mc ON mc.steam_id = le.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = le.steam_id
    LEFT JOIN peak_no_tourney pnt ON pnt.steam_id = le.steam_id
    LEFT JOIN peak_active_regular par ON par.steam_id = le.steam_id
    LEFT JOIN record_streak rs ON rs.steam_id = le.steam_id
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
    -- Active-season tournament eligibility (Exclude Tournaments is off in
    -- this branch): every player_elo row that should count toward this
    -- season's ELO/Last Match/matches when a tournament match happened
    -- during the season. Regular rows are matched by season_id like
    -- everywhere else; tournament rows always carry season_id = NULL (they
    -- are season-independent by design), so they're identified instead by
    -- an existing tournament_brackets link plus falling inside the same
    -- [_from, _to) the season resolved to above. Empty (harmless) whenever
    -- _active_named_season is false, i.e. every rolling/peak/unbounded/
    -- completed-season call.
    season_eligible_elo AS (
      SELECT pe.steam_id, pe.match_id, pe.change, pe.created_at,
        (pe.season_id IS NULL) as is_tournament_row
      FROM player_elo pe
      WHERE _active_named_season
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND (
          pe.season_id = _season_id
          OR (
            pe.season_id IS NULL
            AND pe.created_at >= _from AND pe.created_at < _to
            AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
          )
        )
    ),
    -- Last Match for an active season: the player's own change on their
    -- single most recent eligible row (regular or tournament), using the
    -- same created_at-desc/match_id-desc tie-break as everywhere else in
    -- this function.
    season_last_match AS (
      SELECT DISTINCT ON (see.steam_id)
        see.steam_id, see.change as last_match_change
      FROM season_eligible_elo see
      ORDER BY see.steam_id, see.created_at DESC, see.match_id DESC
    ),
    -- The season's tournament contribution, kept separate from the regular
    -- ladder's `current` column: tournament player_elo.current is a global
    -- value, not a season-scoped one, so it can never stand in for "season
    -- current ELO." Only its own `change` per eligible tournament row is
    -- season-meaningful, summed here and added to the regular season
    -- current ELO in the value CASE below.
    season_tournament_total AS (
      SELECT see.steam_id, SUM(see.change) as tourney_total
      FROM season_eligible_elo see
      WHERE see.is_tournament_row
      GROUP BY see.steam_id
    ),
    -- Every player with at least one eligible row this season, including a
    -- player whose only activity in the season was a tournament match (no
    -- regular season_id row at all). Such a player has no regular-season
    -- baseline to read `current` from, so the value CASE below anchors them
    -- at the same 5000 default every ladder (and every season) starts a
    -- player from -- see match_player_elo.sql's _default_elo and
    -- elo.spec.ts's "5000 baseline" test.
    season_players AS (
      SELECT DISTINCT steam_id FROM season_eligible_elo
    ),
    -- Driving row set: everyone last_elo already covers (rolling/peak/
    -- unbounded/completed-season -- unaffected, season_players is empty for
    -- all of those) unioned with active-season players, which is a
    -- superset of last_elo's regular-only membership for that case.
    driving_players AS (
      SELECT steam_id FROM last_elo
      UNION
      SELECT steam_id FROM season_players
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
        AND (
          (_season_id IS NULL OR pe.season_id = _season_id)
          OR (
            _active_named_season
            AND pe.season_id IS NULL
            AND pe.created_at >= _from AND pe.created_at < _to
            AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
          )
        )
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
    -- All Time Current ELO: the active named season's regular-ladder current
    -- (5000 default with no activity this season) plus the sum of eligible
    -- tournament changes inside the season's date window -- identical
    -- formula to the active-season `value` CASE above, resolved via
    -- get_active_season() instead of the caller's _season_id.
    peak_active_regular AS (
      SELECT DISTINCT ON (pe.steam_id)
        pe.steam_id, pe.current AS active_current
      FROM player_elo pe
      WHERE _use_peak
        AND _peak_active_season_id IS NOT NULL
        AND pe.season_id = _peak_active_season_id
        AND (_match_type IS NULL OR pe.type = _match_type)
      ORDER BY pe.steam_id, pe.created_at DESC, pe.match_id DESC
    ),
    peak_active_tournament AS (
      SELECT pe.steam_id, SUM(pe.change) AS tourney_total
      FROM player_elo pe
      WHERE _use_peak
        AND _peak_active_season_id IS NOT NULL
        AND pe.season_id IS NULL
        AND pe.created_at >= _peak_active_from AND pe.created_at < _peak_active_to
        AND (_match_type IS NULL OR pe.type = _match_type)
        AND EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = pe.match_id)
      GROUP BY pe.steam_id
    ),
    -- All Time Record Win Streak: longest historical run of consecutive
    -- wins, tournaments included in this branch, via the same
    -- gaps-and-islands window-function grouping used in the Exclude
    -- Tournaments branch (just without the tournament_brackets filter).
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
    )
    SELECT
      d.steam_id::text           as player_steam_id,
      p.name                     as player_name,
      p.avatar_url               as player_avatar_url,
      p.country                  as player_country,
      CASE WHEN _use_peak
        THEN pk_e.peak_current::float
        -- Season current ELO with tournaments included: the regular
        -- season ladder's current value (5000 baseline if the player has
        -- no regular-season row at all) plus the sum of their eligible
        -- tournament changes -- never the tournament row's own global
        -- `current`.
        WHEN _active_named_season
        THEN (COALESCE(le.current_elo, 5000) + COALESCE(stt.tourney_total, 0))::float
        ELSE le.current_elo::float
      END                        as value,
      CASE WHEN _use_peak
        THEN (COALESCE(par.active_current, 5000) + COALESCE(pat.tourney_total, 0))::float
        WHEN _unbounded_current
        THEN le.latest_change::float
        WHEN _is_rolling_window
        THEN COALESCE(rc.total_change, 0)::float
        WHEN _active_named_season
        THEN COALESCE(slm.last_match_change, 0)::float
        ELSE (le.current_elo - fe.starting_elo)::float
      END                        as secondary_value,
      CASE WHEN _use_peak
        THEN COALESCE(rs.record_streak, 0)::float
        ELSE COALESCE(ws.streak, 0)::float
      END                        as tertiary_value,
      COALESCE(mc.matches_played, 0)::int as matches_played
    FROM driving_players d
    LEFT JOIN last_elo le ON le.steam_id = d.steam_id
    LEFT JOIN peak_elo pk_e ON pk_e.steam_id = d.steam_id
    LEFT JOIN rolling_change rc ON rc.steam_id = d.steam_id
    LEFT JOIN season_tournament_total stt ON stt.steam_id = d.steam_id
    LEFT JOIN season_last_match slm ON slm.steam_id = d.steam_id
    LEFT JOIN first_elo fe ON fe.steam_id = d.steam_id
    LEFT JOIN match_counts mc ON mc.steam_id = d.steam_id
    LEFT JOIN win_streak ws ON ws.steam_id = d.steam_id
    LEFT JOIN peak_active_regular par ON par.steam_id = d.steam_id
    LEFT JOIN peak_active_tournament pat ON pat.steam_id = d.steam_id
    LEFT JOIN record_streak rs ON rs.steam_id = d.steam_id
    JOIN players p ON p.steam_id = d.steam_id
    ORDER BY value DESC;
  END IF;
END;
$$;
