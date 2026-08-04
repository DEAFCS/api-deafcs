-- Set when a player's leaver ban escalates to the top stage (24h+ELO) during
-- this match. get_player_elo_for_match forces a loss-scored result for this
-- player specifically when true, independent of whether their team actually
-- won the match.
ALTER TABLE public.match_lineup_players
    ADD COLUMN IF NOT EXISTS elo_penalty boolean NOT NULL DEFAULT false;
