-- This additive migration preserves old tournaments and starts a new registration
-- lifecycle. Automatically dropping participant/invite history is destructive.
DO $$ BEGIN
  RAISE EXCEPTION 'Tournament registration rollback requires a reviewed data-preserving migration; automatic down migration is disabled';
END $$;
