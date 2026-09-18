INSERT INTO public.e_sanction_types (value, description)
VALUES ('website_chat_mute', 'Player cannot send messages in website chat')
ON CONFLICT (value) DO UPDATE
SET description = EXCLUDED.description;

ALTER TABLE public.player_sanctions
  ADD COLUMN IF NOT EXISTS revoked_by_steam_id bigint,
  ADD COLUMN IF NOT EXISTS evidence_message_id text;

ALTER TABLE public.player_sanctions
  DROP CONSTRAINT IF EXISTS player_sanctions_revoked_by_steam_id_fkey;

ALTER TABLE public.player_sanctions
  ADD CONSTRAINT player_sanctions_revoked_by_steam_id_fkey
  FOREIGN KEY (revoked_by_steam_id)
  REFERENCES public.players (steam_id)
  ON UPDATE CASCADE
  ON DELETE SET NULL;

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_steam_id bigint;

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_deleted_by_steam_id_fkey;

ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_deleted_by_steam_id_fkey
  FOREIGN KEY (deleted_by_steam_id)
  REFERENCES public.players (steam_id)
  ON UPDATE CASCADE
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.chat_message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id text NOT NULL,
  room_type text NOT NULL,
  room_id text NOT NULL,
  author_steam_id bigint NOT NULL,
  message text NOT NULL,
  message_created_at timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by_steam_id bigint NOT NULL,
  UNIQUE (room_type, room_id, message_id)
);

CREATE INDEX IF NOT EXISTS chat_message_deletions_room_idx
  ON public.chat_message_deletions (room_type, room_id, message_id);

CREATE OR REPLACE FUNCTION public.guard_website_chat_mute()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type <> 'website_chat_mute'
     OR NEW.deleted_at IS NOT NULL
     OR (NEW.remove_sanction_date IS NOT NULL AND NEW.remove_sanction_date <= now()) THEN
    RETURN NEW;
  END IF;

  IF NEW.reason IS NULL OR btrim(NEW.reason) = '' THEN
    RAISE EXCEPTION 'website chat mute reason is required'
      USING ERRCODE = '23514';
  END IF;

  -- Serialize website-mute changes for one player. A partial unique index
  -- cannot express "expiry is in the future" because now() is not immutable.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('website_chat_mute:' || NEW.player_steam_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM public.player_sanctions existing
     WHERE existing.player_steam_id = NEW.player_steam_id
       AND existing.type = 'website_chat_mute'
       AND existing.deleted_at IS NULL
       AND (existing.remove_sanction_date IS NULL OR existing.remove_sanction_date > now())
       AND existing.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'player already has an active website chat mute'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_website_chat_mute ON public.player_sanctions;
CREATE TRIGGER guard_website_chat_mute
BEFORE INSERT OR UPDATE OF type, player_steam_id, remove_sanction_date, deleted_at, reason
ON public.player_sanctions
FOR EACH ROW
EXECUTE FUNCTION public.guard_website_chat_mute();
