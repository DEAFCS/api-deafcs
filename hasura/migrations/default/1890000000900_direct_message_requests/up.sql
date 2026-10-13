-- DEAFCS opt-in: existing and new accounts keep requests disabled until chosen.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS allow_message_requests boolean NOT NULL DEFAULT false;
-- Staff already have explicit broad permissions for OTHER player fields.
-- Keep those unchanged while enforcing self-only consent at the database layer.
-- Hasura sets hasura.user from its trusted authentication webhook. Maintenance
-- connections without that setting remain able to apply defaults/migrations.
CREATE OR REPLACE FUNCTION public.guard_message_requests_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE _session text := current_setting('hasura.user',true);
BEGIN
 IF NEW.allow_message_requests IS DISTINCT FROM OLD.allow_message_requests
    AND NULLIF(_session,'') IS NOT NULL
    AND NEW.steam_id::text IS DISTINCT FROM (_session::jsonb ->> 'x-hasura-user-id') THEN
   RAISE EXCEPTION 'message request preferences are owner-only' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS guard_message_requests_owner ON public.players;
CREATE TRIGGER guard_message_requests_owner BEFORE UPDATE OF allow_message_requests ON public.players
 FOR EACH ROW EXECUTE FUNCTION public.guard_message_requests_owner();
-- Reapplication keeps chosen values while ensuring the opt-in default even if
-- this column existed from a partial setup with a different default.
ALTER TABLE public.players ALTER COLUMN allow_message_requests SET DEFAULT false;
UPDATE public.players SET allow_message_requests=false WHERE allow_message_requests IS NULL;
ALTER TABLE public.players ALTER COLUMN allow_message_requests SET NOT NULL;
CREATE TABLE IF NOT EXISTS public.direct_messages (
 id uuid PRIMARY KEY, seq bigserial NOT NULL, room_id text NOT NULL,
 from_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS direct_messages_room_created_idx ON public.direct_messages(room_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.direct_conversations (
 room_id text NOT NULL, steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
 last_message_at timestamptz NOT NULL DEFAULT now(), is_open boolean NOT NULL DEFAULT true,
 position integer NOT NULL DEFAULT 0, accepted_at timestamptz, declined_at timestamptz,
 PRIMARY KEY(room_id,steam_id)
);
CREATE INDEX IF NOT EXISTS direct_conversations_owner_idx ON public.direct_conversations(steam_id,last_message_at DESC);
CREATE TABLE IF NOT EXISTS public.chat_read_state (
 steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
 thread text NOT NULL, last_read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(steam_id,thread)
);
CREATE OR REPLACE FUNCTION public.is_blocked_either_way(a bigint,b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.player_blocks WHERE
 (blocker_steam_id=a AND blocked_steam_id=b) OR (blocker_steam_id=b AND blocked_steam_id=a)); $$;
-- An accepted friendship, in either direction.
CREATE OR REPLACE FUNCTION public.are_friends(a bigint, b bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.friends f
         WHERE f.status = 'Accepted'
           AND ((f.player_steam_id = a AND f.other_player_steam_id = b)
             OR (f.player_steam_id = b AND f.other_player_steam_id = a))
    );
$$;

-- Whether a party may open a direct room: friends, a conversation that already
-- exists, or someone who takes message requests. plpgsql so the body is not
-- resolved at create time -- is_blocked_either_way is applied after this file.
CREATE OR REPLACE FUNCTION public.can_view_direct_room(_room_id text, _viewer bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _a bigint;
    _b bigint;
    _other bigint;
BEGIN
    IF _viewer IS NULL OR _room_id IS NULL OR _room_id !~ '^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$' THEN RETURN false; END IF;
    _a := split_part(_room_id, ':', 1)::bigint;
    _b := split_part(_room_id, ':', 2)::bigint;
    IF _viewer NOT IN (_a, _b) OR _a >= _b THEN RETURN false; END IF;
    _other := CASE WHEN _a = _viewer THEN _b ELSE _a END;
    IF public.is_blocked_either_way(_viewer, _other) THEN
        RETURN false;
    END IF;

    RETURN public.are_friends(_viewer, _other)
        OR EXISTS (SELECT 1 FROM public.direct_conversations dc
                    WHERE dc.room_id = _room_id)
        OR EXISTS (SELECT 1 FROM public.players p
                    WHERE p.steam_id = _other
                      AND p.allow_message_requests);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN false;
END;
$$;

-- Why _from may not send in _room_id right now, or NULL when they may:
--   blocked        -- either side blocked the other
--   awaiting_reply -- their one request is out and has not been answered
--   requests_off   -- the other side only takes messages from friends
-- Friends always may. So may either side of an accepted conversation, and the
-- recipient of a request, whose reply is what accepts it.
CREATE OR REPLACE FUNCTION public.direct_message_refusal(_room_id text, _from bigint)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _a bigint;
    _b bigint;
    _to bigint;
BEGIN
    IF _from IS NULL OR _room_id IS NULL OR _room_id !~ '^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$' THEN RETURN 'blocked'; END IF;
    _a := split_part(_room_id, ':', 1)::bigint;
    _b := split_part(_room_id, ':', 2)::bigint;
    IF _from NOT IN (_a, _b) OR _a >= _b THEN RETURN 'blocked'; END IF;
    _to := CASE WHEN _a = _from THEN _b ELSE _a END;
    IF public.is_blocked_either_way(_from, _to) THEN
        RETURN 'blocked';
    END IF;

    IF public.are_friends(_from, _to) THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.direct_conversations dc
                WHERE dc.room_id = _room_id
                  AND dc.steam_id = _to
                  AND dc.accepted_at IS NOT NULL
                  AND dc.declined_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.direct_messages dm
                   WHERE dm.room_id = _room_id
                     AND dm.from_steam_id = _to) THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.direct_messages dm
                WHERE dm.room_id = _room_id
                  AND dm.from_steam_id = _from) THEN
        RETURN 'awaiting_reply';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.players p
                    WHERE p.steam_id = _to
                      AND p.allow_message_requests) THEN
        RETURN 'requests_off';
    END IF;

    RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'blocked';
END;
$$;

-- Preserve valid legacy accepted DMs without moving/extending Redis content.
INSERT INTO public.direct_conversations(room_id,steam_id,last_message_at,accepted_at)
 SELECT substring(n.entity_id from 8), p.steam_id, max(n.created_at), max(n.created_at)
 FROM public.notifications n JOIN public.players p ON p.steam_id::text IN
 (split_part(substring(n.entity_id from 8),':',1),split_part(substring(n.entity_id from 8),':',2))
 WHERE n.type::text='ChatMessage'
 AND CASE WHEN n.entity_id ~ '^direct:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$' THEN
   split_part(substring(n.entity_id from 8),':',1)::numeric < split_part(substring(n.entity_id from 8),':',2)::numeric
   AND split_part(substring(n.entity_id from 8),':',2)::numeric <= 9223372036854775807
   AND EXISTS(SELECT 1 FROM public.players peer WHERE peer.steam_id::text = CASE WHEN p.steam_id::text = split_part(substring(n.entity_id from 8),':',1) THEN split_part(substring(n.entity_id from 8),':',2) ELSE split_part(substring(n.entity_id from 8),':',1) END)
 ELSE false END
 GROUP BY n.entity_id,p.steam_id ON CONFLICT(room_id,steam_id) DO NOTHING;
