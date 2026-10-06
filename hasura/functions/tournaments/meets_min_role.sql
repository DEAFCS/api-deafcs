-- Read the acting player's current stored role, not the cached session role.
-- Role changes must agree with target-player roster admission immediately.
-- Keep the existing DEAFCS hierarchy in is_above_role; missing players deny.
CREATE OR REPLACE FUNCTION public.meets_min_role(tournament public.tournaments, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT tournament.min_role IS NULL OR COALESCE(public.is_above_role(
        tournament.min_role,
        json_build_object('x-hasura-role', (
            SELECT p.role FROM public.players p
            WHERE p.steam_id::text = hasura_session ->> 'x-hasura-user-id'
        ))
    ), false);
$$;
