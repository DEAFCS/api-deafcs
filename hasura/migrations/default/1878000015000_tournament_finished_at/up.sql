-- Records when a tournament's status actually became Finished, so the
-- chat sidebar can keep that tournament's chat around for a grace
-- period afterward instead of yanking it the instant the status
-- flips (see TournamentsController.tournament_events, which sets this
-- on the Finished transition). NULL for tournaments finished before
-- this column existed, and for tournaments never finished.
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS finished_at timestamptz NULL;
