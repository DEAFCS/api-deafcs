-- Registration eligibility gate for tournaments.min_role. Delegates the
-- actual role-ordering comparison to the existing is_above_role() helper
-- (same ARRAY[...] ordering AuthStore.isRoleAbove/isRoleAbove.ts already
-- use) so there is a single source of truth for role order. NULL min_role
-- means unrestricted; is_above_role already fails closed (NULL/unmatched
-- roles, including guest, deny) since array_position() returns NULL for a
-- role it doesn't recognize and NULL >= x is NULL, which Hasura treats as
-- denied.
CREATE OR REPLACE FUNCTION public.meets_min_role(tournament public.tournaments, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT tournament.min_role IS NULL
        OR public.is_above_role(tournament.min_role, hasura_session);
$$;
