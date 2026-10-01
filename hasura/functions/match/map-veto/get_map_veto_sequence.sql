-- The whole map veto as the server will run it, for display: one entry per
-- action in get_map_veto_pattern order, with the team that acts on it.
--
--   [{"index": 0, "type": "Ban", "team": 1}, {"index": 1, "type": "Ban", "team": 2},
--    {"index": 2, "type": "Pick", "team": 1}, {"index": 3, "type": "Side", "team": 2}, ...]
--
-- Built only from the functions the veto itself runs on:
-- get_map_veto_pattern (the actions) and get_map_veto_turn_team (whose turn,
-- the rule get_map_veto_picking_lineup_id uses). A Side choice goes to the
-- team that did not make the Pick before it, as get_map_veto_picking_lineup_id
-- decides. team is 1 for lineup_1 and 2 for lineup_2.
--
-- NULL when the match has no map veto or no valid pattern (e.g. a best of
-- larger than its map pool, or a best of the pattern doesn't support), so
-- reading it can never fail a query.
CREATE OR REPLACE FUNCTION public.get_map_veto_sequence(match public.matches)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _has_map_veto boolean;
    _best_of int;
    _pool_size int;
    _pattern text[];
    _steps jsonb := '[]'::jsonb;
    _turn int := 0;
    _team int;
    _last_pick_team int;
    i int;
BEGIN
    SELECT mo.map_veto, mo.best_of,
           (SELECT count(*) FROM _map_pool mp WHERE mp.map_pool_id = mo.map_pool_id)
      INTO _has_map_veto, _best_of, _pool_size
      FROM match_options mo
     WHERE mo.id = match.match_options_id;

    IF NOT COALESCE(_has_map_veto, false)
       OR _best_of NOT IN (1, 3, 5)
       OR _pool_size < _best_of THEN
        RETURN NULL;
    END IF;

    BEGIN
        _pattern := get_map_veto_pattern(match);
    EXCEPTION WHEN SQLSTATE '22000' THEN
        -- 'Not enough maps in the pool for the best of N'
        RETURN NULL;
    END;

    FOR i IN 1..COALESCE(array_length(_pattern, 1), 0) LOOP
        -- An unsupported best of yields an all-NULL pattern.
        IF _pattern[i] IS NULL THEN
            RETURN NULL;
        END IF;

        IF _pattern[i] = 'Side' THEN
            _team := CASE WHEN _last_pick_team = 1 THEN 2 ELSE 1 END;
        ELSE
            _team := get_map_veto_turn_team(_best_of, _turn);
            _turn := _turn + 1;
            IF _pattern[i] = 'Pick' THEN
                _last_pick_team := _team;
            END IF;
        END IF;

        _steps := _steps || jsonb_build_array(
            jsonb_build_object('index', i - 1, 'type', _pattern[i], 'team', _team)
        );
    END LOOP;

    RETURN _steps;
END;
$$;
