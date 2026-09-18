DROP TRIGGER IF EXISTS guard_website_chat_mute ON public.player_sanctions;
DROP FUNCTION IF EXISTS public.guard_website_chat_mute();
DROP TABLE IF EXISTS public.chat_message_deletions;

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_deleted_by_steam_id_fkey,
  DROP COLUMN IF EXISTS deleted_by_steam_id,
  DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE public.player_sanctions
  DROP CONSTRAINT IF EXISTS player_sanctions_revoked_by_steam_id_fkey,
  DROP COLUMN IF EXISTS evidence_message_id,
  DROP COLUMN IF EXISTS revoked_by_steam_id;

DELETE FROM public.player_sanctions WHERE type = 'website_chat_mute';
DELETE FROM public.e_sanction_types WHERE value = 'website_chat_mute';
