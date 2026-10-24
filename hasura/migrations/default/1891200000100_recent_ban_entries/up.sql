-- Type-definition table for recently_banned_players(): one row per player
-- banned recently on Steam or here. Never written to directly; only used as
-- the SETOF return type, like leaderboard_entries.
-- 5stackgg/api 1890000001170_recent_ban_entries, with the vac_banned_on /
-- game_banned_on columns 5Stack added in 1890000001340 included from the
-- start. DEAFCS does not port 1330 (it lifts existing Steam auto-bans) or the
-- players.last_*_ban_at columns.
CREATE TABLE IF NOT EXISTS public.recent_ban_entries (
    steam_id bigint NOT NULL,
    banned_at timestamptz NOT NULL,
    banned_at_source text NOT NULL,
    steam_banned_on date,
    vac_ban_count integer NOT NULL DEFAULT 0,
    game_ban_count integer NOT NULL DEFAULT 0,
    sanction_id uuid,
    sanction_kind text,
    banned_here boolean NOT NULL DEFAULT false,
    first_match_at timestamptz,
    last_match_at timestamptz,
    last_match_map text,
    matches_played integer NOT NULL DEFAULT 0,
    matches_since_steam_ban integer,
    arrived_banned boolean NOT NULL DEFAULT false,
    shared_matches jsonb,
    vac_banned_on date,
    game_banned_on date
);

-- The few players Steam has banned, so the list never scans every player.
CREATE INDEX IF NOT EXISTS idx_players_steam_banned
    ON public.players (steam_id)
    WHERE vac_ban_count > 0 OR game_ban_count > 0;
