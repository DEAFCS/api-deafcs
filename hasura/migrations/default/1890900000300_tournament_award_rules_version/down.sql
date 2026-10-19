ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_award_rules_version_check;
ALTER TABLE public.tournaments DROP COLUMN IF EXISTS award_rules_version;
