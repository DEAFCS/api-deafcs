-- Ported from 5Stack API 9f4c954 (#686). DEAFCS differences: maps with rounds
-- or a demo count as started (in Veto too), a released on-demand server is
-- marked draining, and the clock is refresh_map_veto_pick_expiry.
DROP FUNCTION IF EXISTS public.rewind_map_veto(uuid, int);

CREATE OR REPLACE FUNCTION public.rewind_map_veto(
    _match_id uuid,
    _from_step int,
    _expected_picks int DEFAULT NULL
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match matches;
    _map_veto boolean;
    _picks int;
    _type text;
BEGIN
    SELECT * INTO _match FROM matches WHERE id = _match_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Match not found';
    END IF;

    SELECT map_veto INTO _map_veto FROM match_options WHERE id = _match.match_options_id;

    IF NOT COALESCE(_map_veto, false) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'This match has no map veto';
    END IF;

    IF _match.status NOT IN ('Veto', 'WaitingForServer', 'Live') THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The veto can only be changed before the first map starts';
    END IF;

    -- DEAFCS: checked in Veto too, and a map with rounds or a demo counts as
    -- started. tbd_match_map_veto_picks deletes the match_maps rows of the
    -- picks taken back, and their rounds and stats with them, so only maps
    -- nobody has played may go.
    IF EXISTS (
        SELECT 1 FROM match_maps mm
        WHERE mm.match_id = _match_id
          AND (
            mm.status != 'Scheduled'
            OR EXISTS (SELECT 1 FROM match_map_rounds r WHERE r.match_map_id = mm.id)
            OR EXISTS (SELECT 1 FROM match_map_demos d WHERE d.match_map_id = mm.id)
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The first map has already started';
    END IF;

    SELECT COUNT(*) INTO _picks FROM match_map_veto_picks WHERE match_id = _match_id;

    -- The organizer chose a step from what they were looking at; a pick landing
    -- since then would make the same number mean a different step.
    IF _expected_picks IS NOT NULL AND _expected_picks != _picks THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The veto has moved on since you looked; check it and try again';
    END IF;

    IF _from_step < 1 OR _from_step > _picks THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'That veto step has not been taken';
    END IF;

    SELECT type INTO _type FROM match_map_veto_picks
    WHERE match_id = _match_id
    ORDER BY created_at, id
    OFFSET _from_step - 1
    LIMIT 1;

    -- Nobody chooses the Decider: create_match_map_from_veto places it the
    -- moment one map is left, and a veto rewound to just before it has no step
    -- that could place it again. Taking it back means taking back the step
    -- that left one map.
    IF _type = 'Decider' THEN
        _from_step := _from_step - 1;
    END IF;

    -- Whose turn it is, and what kind of turn, both come from the pick count,
    -- so a step can't be swapped on its own: it and everything after it go.
    -- tbd_match_map_veto_picks drops the match_maps row of every pick deleted.
    DELETE FROM match_map_veto_picks
    WHERE id IN (
        SELECT id FROM match_map_veto_picks
        WHERE match_id = _match_id
        ORDER BY created_at, id
        OFFSET _from_step - 1
    );

    IF _match.status != 'Veto' THEN
        -- The server was booted with the old maps, so it is released and a new
        -- one is assigned when the veto goes Live again. Entering Veto clears a
        -- region-vetoed region; the region picks still stand, so it is put back
        -- while it still has servers to play on. When it can't be, and more
        -- than one region could host, the teams veto the regions again: the
        -- old region picks would leave nothing to ban.
        --
        -- DEAFCS: tau_matches' Canceled case for the released server. The old
        -- pod is stopped at once (match_events sees the server removed), and an
        -- on-demand server goes back into rotation only once the pod is gone
        -- (reconcileDrainingOnDemandServers). Only this match's own reservation.
        UPDATE servers
            SET reserved_by_match_id = NULL,
                draining_match_id = CASE WHEN is_dedicated OR type != 'Ranked'
                    THEN draining_match_id ELSE _match_id END,
                draining_check_at = CASE WHEN is_dedicated OR type != 'Ranked'
                    THEN draining_check_at ELSE now() END
          WHERE id = _match.server_id
            AND reserved_by_match_id = _match_id;

        UPDATE matches SET status = 'Veto', server_id = NULL WHERE id = _match_id;

        IF _match.region IS NOT NULL AND EXISTS (
            SELECT 1 FROM server_regions sr
            WHERE sr.value = _match.region AND total_region_server_count(sr) > 0
        ) THEN
            UPDATE matches SET region = _match.region
            WHERE id = _match_id AND region IS DISTINCT FROM _match.region;
        ELSIF (SELECT region FROM matches WHERE id = _match_id) IS NULL THEN
            DELETE FROM match_region_veto_picks WHERE match_id = _match_id;
        END IF;
    END IF;

    PERFORM refresh_map_veto_pick_expiry(_match_id);
    PERFORM push_back_veto_auto_cancel(_match_id);

    IF _match.status = 'Veto' THEN
        RETURN NULL;
    END IF;

    RETURN _match.server_id;
END;
$$;
