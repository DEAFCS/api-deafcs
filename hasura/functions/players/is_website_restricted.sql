CREATE OR REPLACE FUNCTION public.is_website_restricted(_steam_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.player_sanctions ps
     WHERE ps.player_steam_id = _steam_id
       AND ps.type = 'website_restriction'
       AND ps.deleted_at IS NULL
       AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
  );
$$;
