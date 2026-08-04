-- First time this player actually connected to the game server for this
-- match. NULL means they have never joined at all — used to tell a genuine
-- no-show apart from a player who joined and later disconnected.
ALTER TABLE public.match_lineup_players
    ADD COLUMN IF NOT EXISTS connected_at timestamptz;
