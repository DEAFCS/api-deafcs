DROP FUNCTION IF EXISTS public.get_match_tv_connection_link(match matches, hasura_session json);

-- What a viewer is shown for watching the match, one line per way to watch:
--   playcast "<relay>/<match>"            verified users and up (no server address)
--   connect <host>:<tv_port>; password .. streamers and up (GOTV: shows the real address)
-- Players in the match get nothing. Until the tv delay is up the answer is the single
-- word "pending" for a viewer who will get a stream, and NULL for one who will not.
-- The website picks the lines apart by their first word.
CREATE OR REPLACE FUNCTION public.get_match_tv_connection_string(match public.matches, hasura_session json) RETURNS text
     LANGUAGE plpgsql STABLE
     AS $$
 DECLARE
     password text;
     server_host text;
     tv_port int;
     started_at timestamp;
     tv_delay int;
     match_id uuid;
     use_playcast text;
     relay_domain text;
     lines text[] := ARRAY[]::text[];
 BEGIN
     SELECT s.host, s.tv_port, m.started_at, mo.tv_delay, m.id
     INTO server_host, tv_port, started_at, tv_delay, match_id
     FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        INNER JOIN match_options mo on mo.id = m.match_options_id
     WHERE m.id = match.id
     LIMIT 1;

    IF server_host IS NULL OR started_at IS NULL THEN
         RETURN NULL;
     END IF;

    IF is_in_lineup(match, hasura_session) THEN
        RETURN NULL;
    END IF;

    relay_domain := get_setting('relay_domain', 'https://relay.5stack.gg');
    use_playcast := get_setting('use_playcast', 'false');

    -- Playcast carries no server address, so every verified user may have it.
    IF use_playcast = 'true' AND relay_domain IS NOT NULL
       AND is_above_role('verified_user', hasura_session) THEN
        lines := lines || CONCAT('playcast "', relay_domain, '/', match_id, '"');
    END IF;

    -- GOTV connects to the real address, so it is for streamers and up.
    IF tv_port IS NOT NULL AND is_above_role('streamer', hasura_session) THEN
        password := player_match_password(match, 'tv', hasura_session);

        IF password IS NOT NULL THEN
            lines := lines || CONCAT('connect ', server_host, ':', tv_port, '; password ', password);
        END IF;
    END IF;

    IF array_length(lines, 1) IS NULL THEN
        RETURN NULL;
    END IF;

    -- Something is coming but the tv delay is not up: say so, without the lines,
    -- so the website can show "waiting for the stream" to exactly the viewers
    -- who will get one (not to a verified user when only GOTV is on).
    IF NOW() < started_at + (tv_delay || ' seconds')::interval THEN
        RETURN 'pending';
    END IF;

    RETURN array_to_string(lines, E'\n');
 END;
 $$;
