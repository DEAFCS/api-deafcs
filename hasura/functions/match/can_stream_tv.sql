-- Whether the operator can start a "tv" (GOTV, delayed) game streamer for this
-- match right now. The streamer always watches over GOTV, never Playcast, so
-- this needs a server with a tv_port and waits for the configured tv_delay.
-- It does not depend on what the viewer is shown on the match page.
CREATE OR REPLACE FUNCTION public.can_stream_tv(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF NOT can_stream_live(match, hasura_session) THEN
        RETURN false;
    END IF;

    RETURN COALESCE((
        SELECT s.tv_port IS NOT NULL
               AND m.started_at IS NOT NULL
               AND NOW() >= m.started_at + (mo.tv_delay || ' seconds')::interval
          FROM matches m
         INNER JOIN servers s ON s.id = m.server_id
         INNER JOIN match_options mo ON mo.id = m.match_options_id
         WHERE m.id = match.id
         LIMIT 1
    ), false);
END;
$$;
