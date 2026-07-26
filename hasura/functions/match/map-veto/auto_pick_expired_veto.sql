CREATE OR REPLACE FUNCTION public.auto_pick_expired_veto() RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match matches;
    _lineup_id uuid;
    _pick_type text;
    _map_id uuid;
    _side text;
    _region text;
    _available_regions text[];
    _regions text[];
BEGIN
    -- FOR UPDATE SKIP LOCKED so a slow-running iteration never blocks (or gets
    -- blocked by) a real player pick landing on the same match row concurrently.
    FOR _match IN
        SELECT * FROM matches
        WHERE status = 'Veto'
          AND map_veto_pick_expires_at IS NOT NULL
          AND map_veto_pick_expires_at <= NOW()
        FOR UPDATE SKIP LOCKED
    LOOP
        -- Region veto is still in progress (no region locked in yet).
        IF _match.region IS NULL THEN
            SELECT * INTO _lineup_id FROM get_region_veto_picking_lineup_id(_match);

            IF _lineup_id IS NULL THEN
                CONTINUE;
            END IF;

            SELECT sanitize_match_options_regions(_match.match_options_id) INTO _regions;

            SELECT array_agg(r) INTO _available_regions
            FROM unnest(_regions) AS r
            WHERE NOT EXISTS (
                SELECT 1 FROM match_region_veto_picks mvp
                WHERE mvp.match_id = _match.id AND lower(mvp.region) = lower(r)
            );

            IF COALESCE(array_length(_available_regions, 1), 0) = 0 THEN
                CONTINUE;
            END IF;

            _region := _available_regions[1 + floor(random() * array_length(_available_regions, 1))::int];

            INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
                VALUES (_match.id, 'Ban', _lineup_id, _region);

            CONTINUE;
        END IF;

        -- Map veto turn.
        _pick_type := get_map_veto_type(_match);

        IF _pick_type IS NULL THEN
            CONTINUE;
        END IF;

        SELECT * INTO _lineup_id FROM get_map_veto_picking_lineup_id(_match);

        IF _lineup_id IS NULL THEN
            CONTINUE;
        END IF;

        IF _pick_type = 'Side' THEN
            _side := CASE WHEN random() < 0.5 THEN 'CT' ELSE 'TERRORIST' END;

            SELECT map_id INTO _map_id
            FROM match_map_veto_picks
            WHERE match_id = _match.id AND type = 'Pick'
            ORDER BY created_at DESC
            LIMIT 1;

            IF _map_id IS NULL THEN
                CONTINUE;
            END IF;

            INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side)
                VALUES (_match.id, 'Side', _lineup_id, _map_id, _side);

            CONTINUE;
        END IF;

        SELECT mp.map_id INTO _map_id
        FROM match_options mo
        INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        LEFT JOIN match_map_veto_picks mvp ON mvp.match_id = _match.id AND mvp.map_id = mp.map_id
        WHERE mo.id = _match.match_options_id AND mvp IS NULL
        ORDER BY random()
        LIMIT 1;

        IF _map_id IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
            VALUES (_match.id, _pick_type, _lineup_id, _map_id);
    END LOOP;
END;
$$;
