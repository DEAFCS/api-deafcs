ALTER TABLE public.players
    DROP COLUMN IF EXISTS leaver_ban_stage,
    DROP COLUMN IF EXISTS leaver_ban_stage_expires_at;
