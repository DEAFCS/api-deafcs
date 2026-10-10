-- The per-user notification subscription filters on steam_id (or NULL for
-- broadcasts) and orders by created_at. Without this index every poll was a
-- parallel sequential scan of the whole table (about 380 ms, over a million
-- scans a day). Created live with CREATE INDEX CONCURRENTLY first, so this is
-- a no-op where the index already exists.
CREATE INDEX IF NOT EXISTS notifications_steam_id_created_at_idx
  ON public.notifications (steam_id, created_at DESC);
