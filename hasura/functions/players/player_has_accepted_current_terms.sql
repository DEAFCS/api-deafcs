-- Shared low-level primitive: true only if public.terms_version is set to a
-- non-empty value AND player_terms_acceptances has a row for this exact
-- steam_id + that exact version. A missing/blank terms_version setting
-- fails closed (false), never "treat as accepted". Takes a bare steam_id
-- (not a players row) so it can be called from contexts with no player row
-- in scope, e.g. the draft_game_picks turn-check trigger, which only has
-- current_setting('hasura.user') to identify the acting player.
CREATE OR REPLACE FUNCTION public.player_has_accepted_current_terms(steam_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.settings s
        JOIN public.player_terms_acceptances pta
            ON pta.terms_version = s.value
        WHERE s.name = 'public.terms_version'
        AND s.value IS NOT NULL
        AND s.value <> ''
        AND pta.player_steam_id = player_has_accepted_current_terms.steam_id
    );
$$;
