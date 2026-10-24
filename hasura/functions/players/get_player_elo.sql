CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _active_season_id UUID;
BEGIN
    -- Seasons off: single global ELO ladder per type (pre-seasons behavior)
    IF NOT seasons_enabled() THEN
        return jsonb_build_object(
            'competitive', get_player_elo_by_type(player, 'Competitive'),
            'wingman', get_player_elo_by_type(player, 'Wingman'),
            'duel', get_player_elo_by_type(player, 'Duel')
        );
    END IF;

    _active_season_id := get_active_season();

    return jsonb_build_object(
        'competitive', get_player_season_elo_by_type(player, 'Competitive', _active_season_id),
        'wingman', get_player_season_elo_by_type(player, 'Wingman', _active_season_id),
        'duel', get_player_season_elo_by_type(player, 'Duel', _active_season_id),
        'tournament_competitive', get_player_tournament_elo_by_type(player, 'Competitive'),
        'tournament_wingman', get_player_tournament_elo_by_type(player, 'Wingman'),
        'tournament_duel', get_player_tournament_elo_by_type(player, 'Duel')
    );
END;
$$;

drop function if exists public.get_player_elo_by_type;

CREATE OR REPLACE FUNCTION public.get_player_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
    AND "type" = _type
    ORDER BY created_at DESC
    LIMIT 1;

    -- A player who has never played this match type has no player_elo row
    -- yet. Default them to the baseline starting ELO (5000, same as
    -- match_player_elo.sql uses for a player's very first match) instead of
    -- NULL, which showed as a blank rating and, worse, was read as 0 by
    -- matchmaking team balancing — making a brand-new player look like the
    -- weakest possible player instead of an average one.
    RETURN COALESCE(elo_value, 5000);
END;
$$;

-- Season ELO: latest ELO tagged to this season (season_id-indexed lookup).
-- DEAFCS: a player with no rating in this season yet (the start of a new
-- season) is at the season's starting ELO, 5000, exactly what their first
-- match of the season is calculated from (generate_player_elo_for_match). It
-- used to fall back to their lifetime-latest rating, so after a new season
-- started matchmaking and draft balancing, friends and tournament ELO limits
-- kept using last season's rating while team ranks and the web already showed
-- 5000. Their previous season's rows are untouched. With no season (seasons
-- off, or between seasons) it is the lifetime rating, as before.
CREATE OR REPLACE FUNCTION public.get_player_season_elo_by_type(player public.players, _type text, _season_id UUID) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    IF _season_id IS NULL THEN
        RETURN get_player_elo_by_type(player, _type);
    END IF;

    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
    AND "type" = _type
    AND season_id = _season_id
    ORDER BY created_at DESC
    LIMIT 1;

    RETURN COALESCE(elo_value, 5000);
END;
$$;

-- Tournament ELO: latest ELO from tournament matches (season_id IS NULL + joined with tournament_brackets)
CREATE OR REPLACE FUNCTION public.get_player_tournament_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT pe.current INTO elo_value
    FROM player_elo pe
    INNER JOIN tournament_brackets tb ON tb.match_id = pe.match_id
    WHERE pe.steam_id = player.steam_id
    AND pe."type" = _type
    AND pe.season_id IS NULL
    ORDER BY pe.created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;
