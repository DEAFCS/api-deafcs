-- Personal player-to-player blocking. Mirrors the existing friends/
-- v_my_friends pattern: a plain base table plus a personalized view with
-- INSTEAD OF triggers keyed on the Hasura session variable, so ordinary
-- Hasura role permissions can authorize the whole feature without any
-- NestJS controller in the write path.

CREATE TABLE IF NOT EXISTS public.player_blocks (
  blocker_steam_id bigint NOT NULL,
  blocked_steam_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_steam_id, blocked_steam_id),
  CONSTRAINT player_blocks_no_self_block CHECK (blocker_steam_id <> blocked_steam_id),
  CONSTRAINT player_blocks_blocker_steam_id_fkey FOREIGN KEY (blocker_steam_id)
    REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT player_blocks_blocked_steam_id_fkey FOREIGN KEY (blocked_steam_id)
    REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_player_blocks_blocked_steam_id
  ON public.player_blocks (blocked_steam_id);

-- Personalized view: "my_blocks" -- the players I have blocked, never the
-- reverse (who has blocked me is never exposed to an ordinary user).
DROP VIEW IF EXISTS public.v_my_blocks;
CREATE VIEW public.v_my_blocks AS
SELECT
  pb.blocker_steam_id,
  pb.blocked_steam_id,
  pb.created_at,
  p.steam_id,
  p.name,
  p.avatar_url,
  p.custom_avatar_url,
  p.profile_url
FROM public.player_blocks pb
JOIN public.players p ON p.steam_id = pb.blocked_steam_id;

CREATE OR REPLACE FUNCTION public.ti_v_my_blocks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    my_steam_id bigint;
BEGIN
    my_steam_id := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    IF my_steam_id = NEW.steam_id THEN
        RAISE EXCEPTION 'cannot block yourself' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.player_blocks (blocker_steam_id, blocked_steam_id)
    VALUES (my_steam_id, NEW.steam_id)
    ON CONFLICT (blocker_steam_id, blocked_steam_id) DO NOTHING;

    -- Blocking removes any existing friendship/pending request between the
    -- two players in either direction. guard_friends_not_blocked (below)
    -- then stops a new one from being created while the block stands.
    DELETE FROM public.friends
    WHERE (player_steam_id = my_steam_id AND other_player_steam_id = NEW.steam_id)
       OR (player_steam_id = NEW.steam_id AND other_player_steam_id = my_steam_id);

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.td_v_my_blocks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    my_steam_id bigint;
BEGIN
    my_steam_id := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    -- Only the blocker's own row is ever removable here -- unblocking never
    -- restores the friendship that was removed when the block was created.
    DELETE FROM public.player_blocks
    WHERE blocker_steam_id = my_steam_id AND blocked_steam_id = OLD.steam_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS ti_v_my_blocks ON public.v_my_blocks;
CREATE TRIGGER ti_v_my_blocks INSTEAD OF INSERT ON public.v_my_blocks
  FOR EACH ROW EXECUTE FUNCTION public.ti_v_my_blocks();

DROP TRIGGER IF EXISTS td_v_my_blocks ON public.v_my_blocks;
CREATE TRIGGER td_v_my_blocks INSTEAD OF DELETE ON public.v_my_blocks
  FOR EACH ROW EXECUTE FUNCTION public.td_v_my_blocks();

-- Guard directly on the base `friends` table (not just the v_my_friends
-- INSTEAD OF trigger) so this also catches FriendsService.syncSteamFriends,
-- which inserts into `friends` directly via a superuser Hasura mutation and
-- bypasses the view entirely.
CREATE OR REPLACE FUNCTION public.guard_friends_not_blocked() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.player_blocks
        WHERE (blocker_steam_id = NEW.player_steam_id AND blocked_steam_id = NEW.other_player_steam_id)
           OR (blocker_steam_id = NEW.other_player_steam_id AND blocked_steam_id = NEW.player_steam_id)
    ) THEN
        RAISE EXCEPTION 'cannot create a friend relationship where a block exists'
          USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_friends_not_blocked ON public.friends;
CREATE TRIGGER guard_friends_not_blocked
  BEFORE INSERT OR UPDATE ON public.friends
  FOR EACH ROW EXECUTE FUNCTION public.guard_friends_not_blocked();

-- Party/matchmaking-lobby invites: block a new lobby_players row (an invite
-- or a self-join) between two players with a block between them. Both an
-- invite (invited_by_steam_id <> steam_id) and a self-join into an Open
-- lobby (invited_by_steam_id = steam_id) go through this same insert path;
-- a self-block can never exist (player_blocks' own CHECK constraint), so
-- self-joins are unaffected.
CREATE OR REPLACE FUNCTION public.guard_lobby_players_not_blocked() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.invited_by_steam_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.player_blocks
        WHERE (blocker_steam_id = NEW.invited_by_steam_id AND blocked_steam_id = NEW.steam_id)
           OR (blocker_steam_id = NEW.steam_id AND blocked_steam_id = NEW.invited_by_steam_id)
    ) THEN
        RAISE EXCEPTION 'cannot invite a blocked player' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_lobby_players_not_blocked ON public.lobby_players;
CREATE TRIGGER guard_lobby_players_not_blocked
  BEFORE INSERT ON public.lobby_players
  FOR EACH ROW EXECUTE FUNCTION public.guard_lobby_players_not_blocked();

-- Team invites: tbi_team_roster (hasura/triggers/team_roster.sql) is the
-- BEFORE INSERT trigger that redirects a team_roster insert into a
-- team_invites row. This is a separate, independently-named BEFORE INSERT
-- trigger on the same table/timing -- a RAISE EXCEPTION from either aborts
-- the whole statement, so trigger firing order doesn't affect correctness.
CREATE OR REPLACE FUNCTION public.guard_team_roster_not_blocked() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _inviter bigint;
BEGIN
    _inviter := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    IF _inviter IS NOT NULL AND _inviter <> NEW.player_steam_id AND EXISTS (
        SELECT 1 FROM public.player_blocks
        WHERE (blocker_steam_id = _inviter AND blocked_steam_id = NEW.player_steam_id)
           OR (blocker_steam_id = NEW.player_steam_id AND blocked_steam_id = _inviter)
    ) THEN
        RAISE EXCEPTION 'cannot invite a blocked player' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_team_roster_not_blocked ON public.team_roster;
CREATE TRIGGER guard_team_roster_not_blocked
  BEFORE INSERT ON public.team_roster
  FOR EACH ROW EXECUTE FUNCTION public.guard_team_roster_not_blocked();

-- Verification-application resubmission cooldown: the existing partial
-- unique index (verification_applications_one_pending_per_player) already
-- stops several PENDING applications at once; this adds the missing
-- protection against immediately resubmitting after a rejection. Uses only
-- the authenticated player's own steam_id and the application timestamps
-- already on this table -- no nickname/IP-based signal.
CREATE OR REPLACE FUNCTION public.guard_verification_application_cooldown() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _last_rejected_at timestamptz;
BEGIN
    IF NEW.status <> 'pending' THEN
        RETURN NEW;
    END IF;

    SELECT reviewed_at INTO _last_rejected_at
    FROM public.verification_applications
    WHERE player_steam_id = NEW.player_steam_id
      AND status = 'rejected'
      AND reviewed_at IS NOT NULL
    ORDER BY reviewed_at DESC
    LIMIT 1;

    IF _last_rejected_at IS NOT NULL AND _last_rejected_at > now() - interval '24 hours' THEN
        RAISE EXCEPTION 'you must wait 24 hours after a rejected application before applying again'
          USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_verification_application_cooldown ON public.verification_applications;
CREATE TRIGGER guard_verification_application_cooldown
  BEFORE INSERT ON public.verification_applications
  FOR EACH ROW EXECUTE FUNCTION public.guard_verification_application_cooldown();
