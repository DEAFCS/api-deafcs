ALTER TABLE public.abandoned_matches
  DROP COLUMN IF EXISTS match_id,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS remove_sanction_date;
