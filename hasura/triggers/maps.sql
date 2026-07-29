-- Disabling a map (enabled: true -> false) previously left it as a
-- "zombie" member of _map_pool: still counted in every pool's maps
-- list (index page), but invisible in the per-pool editor (which only
-- lists enabled maps of the matching type), so it could never be
-- unselected from the UI. Enforce the invariant in the database so any
-- code path that disables a map also drops its pool memberships.
CREATE OR REPLACE FUNCTION public.tu_maps_disabled_removes_pool_membership() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public._map_pool WHERE map_id = NEW.id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tu_maps_disabled_removes_pool_membership ON public.maps;
CREATE TRIGGER tu_maps_disabled_removes_pool_membership
AFTER UPDATE OF enabled ON public.maps
FOR EACH ROW
WHEN (NEW.enabled = false AND OLD.enabled = true)
EXECUTE FUNCTION public.tu_maps_disabled_removes_pool_membership();
