-- Reported bug: the "LEAVER" badge (see is_admin_sanctioned/is_banned,
-- PlayerDisplay.vue's activeSanctionType) is driven off the player's
-- GLOBAL ban status, which stays true for the whole escalating
-- matchmaking_cooldown window (10min -> ... -> 1920min, see
-- get_player_matchmaking_cooldown.sql) regardless of which match actually
-- triggered it. That means every match the player appears in while the
-- cooldown is still active shows "LEAVER", not just the one they actually
-- abandoned.
--
-- This is a per-match check instead: did THIS specific match produce an
-- abandoned_matches row for this player? Takes the match id as an extra
-- computed-field argument (Hasura supports this).
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
