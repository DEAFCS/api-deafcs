-- Rollback of tu_maps_disabled_removes_pool_membership: it assumed a
-- disabled map's _map_pool row was always stale, but disabling a map
-- for one mode does not necessarily mean it should be dropped from
-- every pool it was manually added to. Removing the file from
-- hasura/triggers alone does not drop an already-installed trigger on
-- next deploy, so do it explicitly here.
DROP TRIGGER IF EXISTS tu_maps_disabled_removes_pool_membership ON public.maps;
DROP FUNCTION IF EXISTS public.tu_maps_disabled_removes_pool_membership();
