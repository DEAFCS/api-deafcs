-- DEAFCS: one entry per player per tournament. A player with a pool row that is
-- not withdrawn is already in the tournament as a Free Agent, the same way a
-- rostered player or a team owner is in it with a team.
--
-- 5Stack settles the overlap by deleting the pool row when the player lands on
-- a team (tai_tournament_team_roster_free_agents, tai_tournament_teams_free_agents
-- and tau_tournament_team_owner upstream). DEAFCS refuses the second entry
-- instead: nobody is withdrawn from the pool or taken off a team without
-- choosing to leave first. The draft and the waitlist promotion are the only
-- writers that put a pool member on a roster, and they mark themselves with
-- fivestack.free_agent_draft.
CREATE OR REPLACE FUNCTION public.is_tournament_free_agent(
    _tournament_id uuid,
    _player_steam_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_free_agents fa
        WHERE fa.tournament_id = _tournament_id
          AND fa.player_steam_id = _player_steam_id
          AND fa.status <> 'withdrawn'
    );
$$;
