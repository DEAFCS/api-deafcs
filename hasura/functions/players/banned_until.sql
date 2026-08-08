-- Timestamp a player's active ban(s) currently expire at, for showing
-- "banned until <date>" in the UI instead of a bare "you are banned" with
-- no indication of when it lifts. Doesn't distinguish Sanction from
-- Abandoned -- both enforce through the same player_sanctions row, and the
-- player just wants to know when they can play again regardless of which
-- kind it was.
--
-- NULL means either "not banned" or "banned with no end date" (a
-- permanent Sanction) -- the caller is expected to check is_banned first
-- to tell those two apart.
CREATE OR REPLACE FUNCTION public.banned_until(player public.players)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM player_sanctions ps
            WHERE ps.player_steam_id = player.steam_id
              AND ps.type = 'ban'
              AND ps.deleted_at IS NULL
              AND ps.remove_sanction_date IS NULL
        ) THEN NULL
        ELSE (
            SELECT MAX(ps.remove_sanction_date)
            FROM player_sanctions ps
            WHERE ps.player_steam_id = player.steam_id
              AND ps.type = 'ban'
              AND ps.deleted_at IS NULL
              AND ps.remove_sanction_date > now()
        )
    END;
$$;
