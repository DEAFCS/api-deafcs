CREATE OR REPLACE FUNCTION public.refresh_map_veto_pick_expiry(_match_id uuid) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only bump the deadline if veto is still in progress; create_match_map_from_veto
    -- may have already flipped the match to Live (decider auto-pick), in which case
    -- the timer is meaningless and matches.sql's own Live transition clears it.
    UPDATE matches
    SET map_veto_pick_expires_at = NOW() + (get_int_setting('public.map_veto_pick_seconds', 20) || ' seconds')::interval
    WHERE id = _match_id AND status = 'Veto';
END;
$$;
