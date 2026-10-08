DROP INDEX IF EXISTS public.tournament_teams_owner_tournament_only_key;

-- Fails if a manager has since registered two teams in one tournament; those
-- rows have to be resolved by hand before the old rule can come back.
ALTER TABLE public.tournament_teams
    ADD CONSTRAINT tournament_teams_creator_steam_id_tournament_id_key UNIQUE (owner_steam_id, tournament_id);
