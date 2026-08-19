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
        -- IS DISTINCT FROM, not <>: sanctioned_by_steam_id <> 0 silently
        -- excludes NULL rows too (NULL <> 0 is NULL, not true in SQL) --
        -- and NULL is exactly what the VAC-ban auto-sanction system uses
        -- for its own auto-issued bans (see steam-bans.service.ts), a
        -- completely different case from the leaver system's steam_id 0
        -- sentinel. That silently hid every VAC-ban sanction from a
        -- player's profile (reported bug), not just leaver bans.
        AND ps.sanctioned_by_steam_id IS DISTINCT FROM 0
    );
$$;
