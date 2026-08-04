-- Standalone ELO penalty for a player who never joined a match that got
-- auto-canceled as a result. generate_player_elo_for_match always skips
-- matches with no winner (correct -- nobody else in a canceled match should
-- gain or lose ELO), so this exists specifically to still dock the no-show
-- themselves, reusing get_player_elo_for_match's scoring: with
-- winning_lineup_id NULL, that function already naturally scores the call as
-- a loss (0 kills/deaths/damage from never having played).
CREATE OR REPLACE FUNCTION public.apply_no_show_elo_penalty(
    _match_id UUID,
    _steam_id BIGINT
) RETURNS INTEGER AS $$
DECLARE
    match_record public.matches;
    player_record public.players;
    match_type text;
    elo_data JSONB;
    elo_change INTEGER;
    current_elo INTEGER;
    new_elo INTEGER;
    _is_tournament BOOLEAN;
    _season_id UUID;
    _seasons_enabled BOOLEAN;
BEGIN
    SELECT * INTO match_record FROM matches WHERE id = _match_id;

    IF match_record IS NULL THEN
        RETURN 0;
    END IF;

    -- Only a genuine no-play cancellation goes through here. A match that
    -- actually completed is handled by generate_player_elo_for_match instead.
    IF match_record.winning_lineup_id IS NOT NULL THEN
        RETURN 0;
    END IF;

    SELECT * INTO player_record FROM players WHERE steam_id = _steam_id;

    IF player_record IS NULL THEN
        RETURN 0;
    END IF;

    SELECT "type" INTO match_type FROM match_options WHERE id = match_record.match_options_id;

    _is_tournament := is_tournament_match(match_record);
    _seasons_enabled := seasons_enabled();

    IF NOT _seasons_enabled THEN
        _season_id := NULL;
        _is_tournament := FALSE;
    ELSIF _is_tournament THEN
        _season_id := NULL;
    ELSE
        _season_id := season_for_timestamp(COALESCE(match_record.ended_at, match_record.created_at, now()));
    END IF;

    elo_data := get_player_elo_for_match(match_record, player_record, _season_id, _is_tournament);

    IF elo_data IS NULL THEN
        RETURN 0;
    END IF;

    elo_change := COALESCE((elo_data->>'elo_change')::INTEGER, 0);
    current_elo := COALESCE((elo_data->>'current_elo')::INTEGER, 5000);
    new_elo := current_elo + elo_change;

    INSERT INTO player_elo (
        "type", match_id, steam_id, current, change, impact, created_at,
        actual_score, expected_score, k_factor, player_team_elo_avg, opponent_team_elo_avg,
        kills, deaths, assists, damage, kda, team_avg_kda, damage_percent,
        performance_multiplier, map_wins, map_losses, series_multiplier, season_id
    ) VALUES (
        match_type, match_record.id, player_record.steam_id, new_elo, elo_change,
        COALESCE((elo_data->>'impact')::NUMERIC, 1.0),
        COALESCE(match_record.ended_at, now()),
        (elo_data->>'actual_score')::double precision,
        (elo_data->>'expected_score')::double precision,
        (elo_data->>'k_factor')::integer,
        (elo_data->>'player_team_elo_avg')::double precision,
        (elo_data->>'opponent_team_elo_avg')::double precision,
        (elo_data->>'kills')::integer,
        (elo_data->>'deaths')::integer,
        (elo_data->>'assists')::integer,
        (elo_data->>'damage')::integer,
        (elo_data->>'kda')::double precision,
        (elo_data->>'team_avg_kda')::double precision,
        (elo_data->>'damage_percent')::double precision,
        (elo_data->>'performance_multiplier')::double precision,
        (elo_data->>'map_wins')::integer,
        (elo_data->>'map_losses')::integer,
        (elo_data->>'series_multiplier')::integer,
        _season_id
    )
    ON CONFLICT (steam_id, match_id, "type") DO UPDATE SET
        current = EXCLUDED.current,
        change = EXCLUDED.change;

    RETURN elo_change;
END;
$$ LANGUAGE plpgsql;
