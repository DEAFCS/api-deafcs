-- When a team was created ("Founded Mon YYYY" on the team page).
--
-- The column is added WITHOUT a default first and the default is set after, so
-- teams that already exist stay NULL instead of all being stamped with this
-- migration's time. Nothing in the schema records when an existing team was
-- created: the team admin audit only started later and can mis-date a team
-- (for example an owner who left and rejoined), so old teams are NOT backfilled.
-- The page simply omits "Founded" for a team without a date. Every team created
-- from now on is stamped by the default.
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.teams ALTER COLUMN created_at SET DEFAULT now();

COMMENT ON COLUMN public.teams.created_at IS
    'When the team was created. NULL for teams that predate this column.';
