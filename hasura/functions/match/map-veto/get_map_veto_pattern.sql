CREATE OR REPLACE FUNCTION public.get_map_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
AS $$
DECLARE
    pool uuid[];
    best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := '{}';
    i INT;
    pool_size INT;
    _type TEXT;
    ban_count INT;
    pre_bans INT;
    post_bans INT;
BEGIN
    SELECT mo.best_of INTO best_of
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = _match.id;

    SELECT array_agg(mp.map_id) INTO pool
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
    WHERE m.id = _match.id;

    pool_size := coalesce(array_length(pool, 1), 0);

    IF(best_of > pool_size) THEN
        RAISE EXCEPTION 'Not enough maps in the pool for the best of %', best_of USING ERRCODE = '22000';
    END IF;

    -- https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban

    IF best_of = 1 THEN
        -- No picks in BO1: ban every map but one, the last is the Decider.
        -- This is already a pool-size-generic formula (pool_size - 1 bans),
        -- unlike the BO3/BO5 case below.
        FOR i IN 1..(pool_size - 1) LOOP
            base_pattern := array_append(base_pattern, 'Ban');
        END LOOP;
        base_pattern := array_append(base_pattern, 'Decider');
    ELSIF best_of = 3 OR best_of = 5 THEN
        -- ban_count maps must be removed so exactly best_of maps remain
        -- (best_of - 1 picks + 1 decider). Up to 2 bans open the veto --
        -- the normal CS opening -- before the picks; any bans a larger
        -- pool still requires land after the picks, immediately before
        -- the decider, instead of being appended past it. This keeps
        -- Decider the final action and the base_pattern length exactly
        -- pool_size for every pool size, so no separate padding step is
        -- needed (or safe to have) afterwards.
        ban_count := pool_size - best_of;
        pre_bans := LEAST(ban_count, 2);
        post_bans := ban_count - pre_bans;

        FOR i IN 1..pre_bans LOOP
            base_pattern := array_append(base_pattern, 'Ban');
        END LOOP;
        FOR i IN 1..(best_of - 1) LOOP
            base_pattern := array_append(base_pattern, 'Pick');
        END LOOP;
        FOR i IN 1..post_bans LOOP
            base_pattern := array_append(base_pattern, 'Ban');
        END LOOP;
        base_pattern := array_append(base_pattern, 'Decider');
    END IF;

    FOR i IN 1..(pool_size) LOOP
        _type := base_pattern[i];

        pattern := pattern ||
            CASE
                WHEN _type = 'Pick' THEN ARRAY['Pick', 'Side']
                ELSE ARRAY[_type]
            END;
    END LOOP;

    RETURN pattern;
END;
$$;
