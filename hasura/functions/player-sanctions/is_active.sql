CREATE OR REPLACE FUNCTION public.player_sanction_is_active(sanction public.player_sanctions)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT sanction.deleted_at IS NULL
       AND (sanction.remove_sanction_date IS NULL OR sanction.remove_sanction_date > now());
$$;
