-- DEAFCS-only: which rules decide a tournament's automatic placement medals
-- (calculate_tournament_awards).
--
--   1  the rules every tournament had before this migration: the final
--      stage's standings pick the 3rd place, so a single elimination
--      without a third-place match gives bronze to one semifinal loser,
--      and a final stage played in groups medals one group's teams.
--   2  5Stack upstream's rules (5stackgg/api 30ca37b3): the medals follow
--      tournament_placements, so a shared 3rd gets no bronze and a final
--      stage played in groups gets no medals.
--
-- Every existing tournament keeps 1, so its medals stay exactly as earned,
-- however often it is recalculated. Only tournaments inserted after this
-- migration take 2. Nothing may change it: Hasura exposes it read-only.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS award_rules_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.tournaments ALTER COLUMN award_rules_version SET DEFAULT 2;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_award_rules_version_check;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_award_rules_version_check CHECK (award_rules_version IN (1, 2));
