-- One-time cleanup for maps that were disabled before the
-- tu_maps_disabled_removes_pool_membership trigger existed: they were
-- left as unremovable "zombie" members of every pool they were ever
-- part of. Drop those stale _map_pool rows now that the trigger keeps
-- this in sync going forward.
DELETE FROM public._map_pool
WHERE map_id IN (SELECT id FROM public.maps WHERE enabled = false);
