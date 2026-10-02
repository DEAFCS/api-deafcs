ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_elo_voided_by_fkey;
ALTER TABLE public.matches
  DROP COLUMN IF EXISTS elo_voided_by,
  DROP COLUMN IF EXISTS elo_voided_at,
  DROP COLUMN IF EXISTS elo_voided;
