-- @disable-transaction
-- (Must stay the first line: the migration runner then skips its
-- BEGIN/COMMIT wrapper, which CREATE INDEX CONCURRENTLY cannot run inside.
-- Keep this file to this ONE statement: several statements sent together
-- would run in an implicit transaction again.)
--
-- match_requested_organizer() (the matches.requested_organizer computed
-- field) checks for an unread MatchSupport notification of one match:
--   entity_id = match.id::text AND type = 'MatchSupport' AND is_read = false
-- Without an index every evaluation was a parallel sequential scan of the
-- whole notifications table (about 26-41 ms per call in production). This
-- partial index holds only unread MatchSupport rows, so it stays tiny and the
-- check becomes an index lookup. CONCURRENTLY keeps notification writes
-- unblocked while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_match_support_unread_idx
  ON public.notifications (entity_id)
  WHERE type = 'MatchSupport' AND is_read = false
