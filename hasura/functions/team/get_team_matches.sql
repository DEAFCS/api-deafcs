CREATE OR REPLACE FUNCTION public.get_team_matches(team public.teams)
RETURNS SETOF public.matches
LANGUAGE sql
STABLE
AS $$
    -- Team stats are tournament matches only -- a team's page showing
    -- matchmaking games (even ones legitimately played by the whole
    -- roster) was decided against, since MM was never meant to count
    -- toward a team's record.
    SELECT DISTINCT m.*
    FROM match_lineups ml
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE ml.team_id = team.id
      AND is_tournament_match(m);
$$;
