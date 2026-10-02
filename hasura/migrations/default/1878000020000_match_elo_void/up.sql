-- Admin "Void ELO": a played match whose rating effect is removed for every
-- player (e.g. a cheater confirmed afterwards). The match, score, stats,
-- demos and clips stay; get_player_elo_for_match scores it as a 0 change, so
-- every recompute keeps it voided.
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS elo_voided boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS elo_voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS elo_voided_by bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_elo_voided_by_fkey'
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_elo_voided_by_fkey
      FOREIGN KEY (elo_voided_by) REFERENCES public.players(steam_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;
