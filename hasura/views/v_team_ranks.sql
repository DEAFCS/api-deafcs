DROP VIEW IF EXISTS v_team_ranks;

-- Team-ranks-only Competitive ELO. get_player_elo()/get_player_season_elo_by_type()
-- (hasura/functions/players/get_player_elo.sql) fall back to a player's
-- lifetime-latest player_elo row when they have no row for the active
-- season -- correct for their other callers (draft_game_players.sql
-- matchmaking balancing, v_my_friends.sql, the players.elo GraphQL field),
-- but the web already overrides that fallback for on-screen display
-- (composables/usePlayerActiveSeasonElo.ts: season row wins, else the
-- season starting ELO of 5000, never the stale lifetime value). This helper
-- gives v_team_ranks the same season-row-or-5000 rule so the team header
-- agrees with the roster it's averaging, without touching the shared
-- get_player_elo functions or their other callers.
CREATE OR REPLACE FUNCTION public._team_rank_competitive_elo(player public.players) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _active_season_id UUID;
    elo_value numeric;
BEGIN
    IF NOT seasons_enabled() THEN
        RETURN get_player_elo_by_type(player, 'Competitive');
    END IF;

    _active_season_id := get_active_season();

    -- Off-season gap (seasons enabled, but none active right now): same
    -- convention get_player_elo() itself already falls back to.
    IF _active_season_id IS NULL THEN
        RETURN get_player_elo_by_type(player, 'Competitive');
    END IF;

    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
      AND "type" = 'Competitive'
      AND season_id = _active_season_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- No row in the active season yet: season starting ELO, never the
    -- player's older/lifetime rating.
    RETURN COALESCE(elo_value, 5000);
END;
$$;

-- Aggregate the same per-player values the app actually displays
-- (_team_rank_competitive_elo + the players faceit/premier columns) across
-- the current playing roster, so team page, team cards and the scrim finder
-- all agree. Players without a value are simply excluded from that average
-- (NULL is ignored), rather than dragged toward a default. Coaches are
-- excluded entirely -- they aren't playing roster members and shouldn't
-- move the team's rating.
CREATE OR REPLACE VIEW v_team_ranks AS
SELECT
    tr.team_id,
    count(*) AS roster_size,
    avg(e.competitive)::INTEGER AS avg_elo,
    min(e.competitive)::INTEGER AS min_elo,
    max(e.competitive)::INTEGER AS max_elo,
    round(avg(NULLIF(p.faceit_skill_level, 0)), 2)::FLOAT AS avg_faceit_level,
    avg(NULLIF(p.faceit_elo, 0))::INTEGER AS avg_faceit_elo,
    avg(NULLIF(p.premier_rank, 0))::INTEGER AS avg_premier
FROM team_roster tr
JOIN players p ON p.steam_id = tr.player_steam_id
LEFT JOIN LATERAL (
    SELECT NULLIF(_team_rank_competitive_elo(p), 0) AS competitive
) e ON true
WHERE tr.coach = false
GROUP BY tr.team_id;
