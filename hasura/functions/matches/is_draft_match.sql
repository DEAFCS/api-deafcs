-- Mirrors is_tournament_match.sql. A match created from a draft/pickup
-- lobby (Open Match / AUTO-SPLIT) links back via draft_games.match_id --
-- used by tbid_match_lineup_players (and could be exposed as a computed
-- field later) to extend the Sanction-vs-Abandoned ban distinction (see
-- is_admin_sanctioned) to draft matches the same way it already applies to
-- tournament matches: an automatic leaver/no-show ban ("Abandoned") should
-- not block joining, only a real admin Sanction should.
CREATE OR REPLACE FUNCTION public.is_draft_match(match public.matches)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.draft_games dg
        WHERE dg.match_id = match.id
    );
$$;
