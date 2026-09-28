ALTER TABLE public.player_sanctions
  ADD COLUMN IF NOT EXISTS notify_teammates boolean NOT NULL DEFAULT false;
