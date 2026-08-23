-- players computed field. Delegates to player_has_accepted_current_terms so
-- there is exactly one place that knows how to read terms_version and check
-- acceptance (also reused by the draft_game_picks turn-check trigger, which
-- has no players row to call this with).
CREATE OR REPLACE FUNCTION public.has_accepted_current_terms(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT public.player_has_accepted_current_terms(player.steam_id);
$$;
