-- Like is_banned, but excludes the reserved system player (steam_id 0)
-- used exclusively for automatic leaver/no-show bans ("Abandoned") --
-- only counts a real admin-issued ban ("Sanction"). Used wherever a
-- tournament match cares about a real sanction but not an automated
-- leaver ban (e.g. tbid_match_lineup_players, which otherwise blocked a
-- leaver-banned player from ever being added to a tournament lineup).
CREATE OR REPLACE FUNCTION public.is_admin_sanctioned(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM player_sanctions ps
        WHERE ps.player_steam_id = player.steam_id
        AND ps.type = 'ban'
        AND ps.deleted_at IS NULL
        AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
        AND ps.sanctioned_by_steam_id <> 0
    );
$$;
