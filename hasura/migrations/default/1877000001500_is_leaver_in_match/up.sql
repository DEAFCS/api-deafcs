-- See hasura/functions/players/is_leaver_in_match.sql for the full comment.
CREATE OR REPLACE FUNCTION public.is_leaver_in_match(player public.players, match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.abandoned_matches am
        WHERE am.steam_id = player.steam_id
          AND am.match_id = $2
    );
$$;
