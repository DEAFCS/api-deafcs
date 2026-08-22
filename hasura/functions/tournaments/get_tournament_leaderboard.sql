-- Tournament-scoped player leaderboard for the web Stats tab.
--
-- Deliberately assembled from two already-proven aggregations rather than a
-- new formula:
--   * kills/deaths/assists/headshots/matches_played -- the exact per-player
--     aggregation already used by v_tournament_player_stats (kill-event
--     unpivot for K/D/HS, lineup membership for matches_played).
--   * rating/adr -- the exact rounds-weighted aggregation already used by
--     get_event_leaderboard (SUM(value * rounds_played) / SUM(rounds_played)
--     over player_match_map_stats / v_player_match_map_hltv), which is what
--     makes mixing Bo1/Bo3 matches mathematically valid instead of a naive
--     per-match average.
--
-- Returns a dedicated type (tournament_leaderboard_entries) instead of the
-- shared leaderboard_entries table: this needs team identity and multiple
-- named stat columns at once (not a single category-swapped "value" like
-- get_leaderboard/get_event_leaderboard), and leaderboard_entries is shared
-- by three other producers matched by column position.
CREATE OR REPLACE FUNCTION public.get_tournament_leaderboard(
  _tournament_id UUID,
  hasura_session JSON DEFAULT NULL
)
RETURNS SETOF public.tournament_leaderboard_entries
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH t_matches AS (
    SELECT DISTINCT tb.match_id
    FROM public.tournament_brackets tb
    JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE ts.tournament_id = _tournament_id
      AND tb.match_id IS NOT NULL
  ),
  -- Kills, deaths and headshots come from the same player_kills rows,
  -- unpivoted one row per side -- identical approach to
  -- v_tournament_player_stats.
  kd_agg AS (
    SELECT
        e.steam_id,
        SUM(e.kill_flag)::int AS kills,
        SUM(e.death_flag)::int AS deaths,
        SUM(e.headshot_flag)::int AS headshots
    FROM t_matches tm
    JOIN public.player_kills pk
      ON pk.match_id = tm.match_id
     AND pk.attacker_steam_id IS NOT NULL
     AND pk.attacker_steam_id != pk.attacked_steam_id
    CROSS JOIN LATERAL (VALUES
        (pk.attacker_steam_id, 1, 0, CASE WHEN pk.headshot THEN 1 ELSE 0 END),
        (pk.attacked_steam_id, 0, 1, 0)
    ) AS e(steam_id, kill_flag, death_flag, headshot_flag)
    WHERE e.steam_id IS NOT NULL
    GROUP BY e.steam_id
  ),
  assists_agg AS (
    SELECT pa.attacker_steam_id AS steam_id, COUNT(*)::int AS assists
    FROM t_matches tm
    JOIN public.player_assists pa ON pa.match_id = tm.match_id
    WHERE pa.attacker_steam_id IS NOT NULL
    GROUP BY pa.attacker_steam_id
  ),
  matches_agg AS (
    SELECT mlp.steam_id, COUNT(DISTINCT tm.match_id)::int AS matches_played
    FROM t_matches tm
    JOIN public.matches m ON m.id = tm.match_id
    JOIN public.match_lineup_players mlp
      ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE mlp.steam_id IS NOT NULL
    GROUP BY mlp.steam_id
  ),
  -- Rounds-weighted rating/ADR -- same math as get_event_leaderboard's `agg`
  -- CTE, just scoped to t_matches (tournament brackets) instead of
  -- e_matches (event_match_links). Rounds-weighting here is what makes
  -- rolling straight from map-level to tournament-level valid without an
  -- intermediate per-match step: weighted averaging is associative, so
  -- summing rating*rounds and rounds across every map in the tournament
  -- gives the same result as weighting per-match averages by their rounds.
  rating_agg AS (
    SELECT
        pmms.steam_id,
        SUM(pmms.damage)::float AS damage,
        SUM(pmms.rounds_played)::int AS rounds_played,
        CASE WHEN SUM(h.rounds_played) > 0
             THEN (SUM(COALESCE(h.hltv_rating, 0) * h.rounds_played)
                  / SUM(h.rounds_played))::float
             ELSE 0::float
        END AS rating
    FROM t_matches tm
    JOIN public.player_match_map_stats pmms ON pmms.match_id = tm.match_id
    LEFT JOIN public.v_player_match_map_hltv h
           ON h.match_map_id = pmms.match_map_id
          AND h.steam_id = pmms.steam_id
    GROUP BY pmms.steam_id
  ),
  -- Team identity: tournament_team_roster already covers both normal team
  -- tournaments and Solo Random (team generation inserts roster rows the
  -- same way a normal team join does), so this is the one source that works
  -- for both without special-casing. DISTINCT ON guards the (currently
  -- unenforced) possibility of more than one roster row for the same player
  -- in the same tournament; there is no created_at column to break ties by
  -- recency, so the tiebreak is an arbitrary but stable ordering rather than
  -- a meaningful "most recent" pick -- acceptable because the data model
  -- does not support a player being on two tournament teams at once by
  -- design, this only guards against that assumption ever being violated.
  team_resolution AS (
    SELECT DISTINCT ON (ttr.player_steam_id)
        ttr.player_steam_id,
        ttr.tournament_team_id,
        tt.team_id,
        COALESCE(t.name, tt.name) AS team_name
    FROM public.tournament_team_roster ttr
    JOIN public.tournament_teams tt ON tt.id = ttr.tournament_team_id
    LEFT JOIN public.teams t ON t.id = tt.team_id
    WHERE ttr.tournament_id = _tournament_id
    ORDER BY ttr.player_steam_id, ttr.tournament_team_id
  )
  SELECT
      m.steam_id::text AS player_steam_id,
      p.name AS player_name,
      p.avatar_url AS player_avatar_url,
      p.custom_avatar_url AS player_custom_avatar_url,
      p.country AS player_country,
      tr.tournament_team_id,
      tr.team_id,
      tr.team_name,
      COALESCE(r.rating, 0)::float AS rating,
      CASE WHEN COALESCE(r.rounds_played, 0) > 0
           THEN ROUND((r.damage / r.rounds_played)::numeric, 1)::float
           ELSE 0
      END AS adr,
      COALESCE(kd.kills, 0) AS kills,
      COALESCE(kd.deaths, 0) AS deaths,
      COALESCE(a.assists, 0) AS assists,
      CASE WHEN COALESCE(kd.deaths, 0) = 0 THEN COALESCE(kd.kills, 0)::float
           ELSE ROUND(COALESCE(kd.kills, 0)::numeric / kd.deaths::numeric, 2)::float
      END AS kdr,
      CASE WHEN COALESCE(kd.kills, 0) = 0 THEN 0::float
           ELSE ROUND(COALESCE(kd.headshots, 0)::numeric / kd.kills::numeric * 100, 1)::float
      END AS headshot_percentage,
      COALESCE(r.rounds_played, 0) AS rounds_played,
      m.matches_played
  FROM matches_agg m
  JOIN public.players p ON p.steam_id = m.steam_id
  LEFT JOIN kd_agg kd ON kd.steam_id = m.steam_id
  LEFT JOIN assists_agg a ON a.steam_id = m.steam_id
  LEFT JOIN rating_agg r ON r.steam_id = m.steam_id
  LEFT JOIN team_resolution tr ON tr.player_steam_id = m.steam_id
  -- No LIMIT: paginated at the Hasura level (order_by/limit/offset), same
  -- reasoning as get_event_leaderboard.
  ORDER BY COALESCE(r.rating, 0) DESC;
END;
$$;
