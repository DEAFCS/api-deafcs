-- Enforces the matchmaking lobby's max-5-players cap at the database
-- level. Membership changes (invite, self-join into an Open/Friends
-- lobby) are done as direct client-side Hasura mutations with no
-- backend endpoint in between (see inviteToLobby/joinLobby in
-- deafcs-web), so Hasura's row-level insert/update permissions are the
-- only gate before this -- and those don't support aggregate checks.
-- A trigger is the only synchronous place left to reject an
-- over-capacity join with a real error instead of silently allowing
-- a 6th+ player in.
--
-- Only fires on a transition TO 'Accepted' (insert or update) -- the
-- self-join flow always inserts as 'Invited' first (insert_permissions
-- doesn't allow setting status), then updates to 'Accepted' in the
-- same GraphQL request/transaction, so checking here still rejects the
-- whole request atomically if the lobby is already full.
CREATE OR REPLACE FUNCTION public.enforce_lobby_capacity()
RETURNS trigger AS $$
DECLARE
  accepted_count integer;
BEGIN
  IF NEW.status = 'Accepted' THEN
    SELECT count(*) INTO accepted_count
    FROM public.lobby_players
    WHERE lobby_id = NEW.lobby_id
      AND status = 'Accepted'
      AND steam_id <> NEW.steam_id;

    IF accepted_count >= 5 THEN
      RAISE EXCEPTION 'lobby is full (max 5 players)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lobby_players_capacity_check ON public.lobby_players;
CREATE TRIGGER lobby_players_capacity_check
  BEFORE INSERT OR UPDATE ON public.lobby_players
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_lobby_capacity();
