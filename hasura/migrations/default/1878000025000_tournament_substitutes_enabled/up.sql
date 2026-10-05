-- Adapted from 5Stack (1886000000619_tournament_substitutes_enabled, MIT).
-- Per-tournament switch for substitutes. The allowance itself stays the
-- tournament match options' number_of_substitutes (filled from the global
-- team substitute setting); this only turns it on or off. Defaults to true
-- so every existing tournament keeps exactly its current roster capacity.
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS substitutes_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournaments.substitutes_enabled IS 'Whether teams may roster and field substitutes beyond the starting lineup';
