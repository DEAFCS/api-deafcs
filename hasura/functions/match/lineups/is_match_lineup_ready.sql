CREATE OR REPLACE FUNCTION public.is_match_lineup_ready(match_lineup public.match_lineups)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    match_type text;
    total_checked_in int;
    _check_in_setting text;
BEGIN
    SELECT mo.type, mo.check_in_setting
    INTO match_type, _check_in_setting
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = match_lineup.match_id
    LIMIT 1;

    -- A tournament match is played by the starting lineup only. A lineup that
    -- still seats more than that (a match created before starting lineups
    -- existed) has no valid selection yet, so it cannot be ready until the
    -- team's staff choose the active players (set_match_starting_lineup).
    IF EXISTS (SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = match_lineup.match_id)
       AND (
           SELECT count(*) FROM match_lineup_players mlp
            WHERE mlp.match_lineup_id = match_lineup.id
       ) > get_match_type_min_players(match_type) THEN
        RETURN false;
    END IF;

    -- A team with substitutes has to confirm its starting lineup first.
    IF match_lineup_needs_starting_lineup_confirmation(match_lineup) THEN
        RETURN false;
    END IF;

    IF _check_in_setting = 'Captains' THEN
        SELECT count(*)
        INTO total_checked_in
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match_lineup.id AND mlp.checked_in = true
        AND mlp.captain = true;

        RETURN total_checked_in = 1;
    END IF;

    SELECT count(*)
    INTO total_checked_in
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = match_lineup.id AND mlp.checked_in = true;

    RETURN total_checked_in >= get_match_type_min_players(match_type);
END;
$$;
