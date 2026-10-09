-- When a tournament team explicitly confirmed the starting lineup of a match.
--
-- NULL means "the default lineup was generated and nobody chose it". A team
-- with substitutes has to confirm before its lineup can be ready or check in,
-- so that a free win or a no-show, which record no play at all, can still be
-- rated over the players who were meant to play. Teams without substitutes
-- never need it. Matches that already exist are not backfilled: for them the
-- requirement is derived from the roster and applies until a lineup is
-- confirmed, and a match that has already started is never touched.
ALTER TABLE public.match_lineups
    ADD COLUMN IF NOT EXISTS starting_lineup_confirmed_at timestamptz;

COMMENT ON COLUMN public.match_lineups.starting_lineup_confirmed_at IS
    'When the starting lineup of a tournament match was explicitly confirmed; NULL while it is only the generated default.';
