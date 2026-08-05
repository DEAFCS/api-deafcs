-- Standalone flat ELO penalty for a player who never joined a match that got
-- auto-canceled as a result. generate_player_elo_for_match always skips
-- matches with no winner (correct -- nobody else in a canceled match should
-- gain or lose ELO), so this exists specifically to still dock the no-show
-- themselves. Flat -250 rather than the dynamic win/loss formula: there's no
-- game played to score, and a formula-driven amount produced inconsistent,
-- sometimes very mild results depending on relative ELO.
CREATE OR REPLACE FUNCTION public.apply_no_show_elo_penalty(
    _match_id UUID,
    _steam_id BIGINT,
    _penalty INTEGER DEFAULT 250
) RETURNS INTEGER AS $$
DECLARE
    match_record public.matches;
    match_type text;
    current_elo INTEGER;
    new_elo INTEGER;
    elo_change INTEGER;
    _is_tournament BOOLEAN;
    _season_id UUID;
    _seasons_enabled BOOLEAN;
    _default_elo INTEGER := 5000;
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

    IF NOT EXISTS (SELECT 1 FROM players WHERE steam_id = _steam_id) THEN
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

    IF NOT _seasons_enabled THEN
        SELECT pe.current INTO current_elo
        FROM player_elo pe
        WHERE pe.steam_id = _steam_id
        AND pe.created_at < now()
        AND pe.match_id != match_record.id
        AND pe."type" = match_type
        ORDER BY pe.created_at DESC
        LIMIT 1;
    ELSIF _is_tournament THEN
        SELECT pe.current INTO current_elo
        FROM player_elo pe
        INNER JOIN tournament_brackets tb ON tb.match_id = pe.match_id
        WHERE pe.steam_id = _steam_id
        AND pe.created_at < now()
        AND pe.match_id != match_record.id
        AND pe."type" = match_type
        AND pe.season_id IS NULL
        ORDER BY pe.created_at DESC
        LIMIT 1;
    ELSIF _season_id IS NOT NULL THEN
        SELECT pe.current INTO current_elo
        FROM player_elo pe
        WHERE pe.steam_id = _steam_id
        AND pe.created_at < now()
        AND pe.match_id != match_record.id
        AND pe."type" = match_type
        AND pe.season_id = _season_id
        ORDER BY pe.created_at DESC
        LIMIT 1;
    ELSE
        current_elo := _default_elo;
    END IF;

    IF current_elo IS NULL THEN
        current_elo := _default_elo;
    END IF;

    elo_change := -_penalty;
    new_elo := GREATEST(0, current_elo + elo_change);

    INSERT INTO player_elo (
        "type", match_id, steam_id, current, change, created_at, season_id
    ) VALUES (
        match_type, match_record.id, _steam_id, new_elo, elo_change,
        COALESCE(match_record.ended_at, now()), _season_id
    )
    ON CONFLICT (steam_id, match_id, "type") DO UPDATE SET
        current = EXCLUDED.current,
        change = EXCLUDED.change;

    RETURN elo_change;
END;
$$ LANGUAGE plpgsql;
