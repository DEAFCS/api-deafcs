-- A team manager (owner, team Admin or captain) may enter several of their
-- teams in one tournament, so (owner_steam_id, tournament_id) can no longer be
-- unique for registered teams. The rules that matter are enforced elsewhere
-- and are unchanged:
--   * a team is entered once per tournament: tournament_teams_tournament_id_team_id_key
--   * a player is on one roster per tournament: tournament_roster_pkey
--
-- The one-per-owner rule is kept where it still means something: teams that
-- have no teams row (tournament-only and drafted teams, team_id IS NULL).
-- A unique index, not a constraint, so Hasura's on_conflict enum is unchanged
-- apart from losing the old constraint name.
ALTER TABLE public.tournament_teams
    DROP CONSTRAINT IF EXISTS tournament_teams_creator_steam_id_tournament_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_teams_owner_tournament_only_key
    ON public.tournament_teams (owner_steam_id, tournament_id)
    WHERE team_id IS NULL;
