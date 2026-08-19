-- New tournaments should not automatically give awards; organizers opt in
-- deliberately (random/casual tournaments should not award anything by
-- default). Existing tournaments keep whatever value they already have --
-- this only changes the default applied to future inserts. awards_enabled
-- and trophies_enabled are kept in sync by the existing
-- sync_tournament_awards_enabled trigger, so both defaults must match.
ALTER TABLE public.tournaments
    ALTER COLUMN awards_enabled SET DEFAULT false;
ALTER TABLE public.tournaments
    ALTER COLUMN trophies_enabled SET DEFAULT false;
