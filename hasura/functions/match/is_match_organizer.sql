CREATE OR REPLACE FUNCTION public.is_match_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'match_organizer')
        OR match.organizer_steam_id = nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
        OR EXISTS (
            SELECT 1
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            INNER JOIN tournaments t ON t.id = ts.tournament_id
            WHERE tb.match_id = match.id
              AND (
                  t.organizer_steam_id = nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
                  OR EXISTS (
                      SELECT 1 FROM tournament_organizers tournament_organizer
                       WHERE tournament_organizer.tournament_id = t.id
                         AND tournament_organizer.steam_id = nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
                  )
              )
        );
$$;
