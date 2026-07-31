ALTER TABLE public.draft_games
  ADD COLUMN IF NOT EXISTS elo_enabled boolean NOT NULL DEFAULT true;
