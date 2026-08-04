-- Escalation ladder for leaver/no-show bans: stage 1 = 30min, 2 = 2h,
-- 3 = 24h, 4+ = 24h + ELO penalty. stage_expires_at is the decay deadline —
-- if no new violation happens before it, the next violation starts back at
-- stage 1 instead of escalating further.
ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS leaver_ban_stage integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS leaver_ban_stage_expires_at timestamptz;
