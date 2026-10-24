-- DEAFCS ELO v2 (every rated 5v5 match), the two formula pieces that differ
-- from version 1, kept as pure functions so their values can be checked
-- exactly. get_player_elo_for_match (hasura/functions/match/
-- match_player_elo.sql) uses them; Duel and Wingman never do.

-- Expected score of a player against the opponents' average rating:
-- 1 / (1 + 10^((opponent - player) / scale)). Scale 10000 for ELO v2, 4000
-- for version 1.
CREATE OR REPLACE FUNCTION public.elo_expected_score(
    _player_elo double precision,
    _opponent_elo double precision,
    _scale integer
)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
    SELECT 1.0 / (1.0 + power(10.0, (_opponent_elo - _player_elo) / _scale));
$$;

-- PERF from the player's existing DEAFCS HLTV-style match rating:
-- win = clamp(1 + 0.5 * (rating - 1.00), 0.75, 1.25), loss = 2 - win.
-- 0.50 or lower -> 0.75 / 1.25, 1.00 -> 1.00 / 1.00, 1.50 or higher ->
-- 1.25 / 0.75. No rating (no rounds or KAST data) is neutral, 1.00.
CREATE OR REPLACE FUNCTION public.elo_v2_performance_multiplier(
    _hltv_rating double precision,
    _won boolean
)
RETURNS double precision
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE WHEN _won THEN win_perf ELSE 2.0 - win_perf END
      FROM (
          SELECT GREATEST(0.75, LEAST(1.25,
                     1.0 + 0.5 * (COALESCE(_hltv_rating, 1.0) - 1.0))) AS win_perf
      ) p;
$$;
