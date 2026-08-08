CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup_teams(bracket public.tournament_brackets) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    match matches;
    _lineup_1_id UUID;
    _lineup_2_id UUID;
    _captain_steam_id_1 bigint;
    _captain_steam_id_2 bigint;
    _max_players_per_lineup int;
    _lineup RECORD;
    member RECORD;
BEGIN
    IF bracket.match_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO match FROM matches WHERE id = bracket.match_id;

    IF match.id IS NULL THEN
        RETURN;
    END IF;

    -- Only safe to rewrite lineups for a match that hasn't been played yet.
    -- A Live/Finished/decided match must never be patched in place here --
    -- organizers use the reset-match flow (delete & recreate) for that case.
    IF match.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled') THEN
        RETURN;
    END IF;

    _lineup_1_id := match.lineup_1_id;
    _lineup_2_id := match.lineup_2_id;

    SELECT tt.captain_steam_id INTO _captain_steam_id_1
    FROM tournament_teams tt WHERE tt.id = bracket.tournament_team_id_1;

    SELECT tt.captain_steam_id INTO _captain_steam_id_2
    FROM tournament_teams tt WHERE tt.id = bracket.tournament_team_id_2;

    SELECT match_max_players_per_lineup(match) INTO _max_players_per_lineup;

    FOR _lineup IN
        SELECT * FROM (VALUES
            (_lineup_1_id, bracket.tournament_team_id_1, _captain_steam_id_1),
            (_lineup_2_id, bracket.tournament_team_id_2, _captain_steam_id_2)
        ) AS l(match_lineup_id, tournament_team_id, captain_steam_id)
    LOOP
        DELETE FROM match_lineup_players WHERE match_lineup_id = _lineup.match_lineup_id;

        UPDATE match_lineups
           SET team_id = (
               SELECT tt.team_id FROM tournament_teams tt WHERE tt.id = _lineup.tournament_team_id
           )
         WHERE match_lineups.id = _lineup.match_lineup_id;

        IF _lineup.tournament_team_id IS NULL THEN
            CONTINUE;
        END IF;

        FOR member IN
            SELECT ttr.*
            FROM tournament_team_roster ttr
            INNER JOIN tournament_teams tt
              ON tt.id = ttr.tournament_team_id
            LEFT JOIN team_roster tr
              ON tr.team_id = tt.team_id
             AND tr.player_steam_id = ttr.player_steam_id
            WHERE ttr.tournament_team_id = _lineup.tournament_team_id
            ORDER BY
                CASE WHEN ttr.player_steam_id = _lineup.captain_steam_id THEN 0 ELSE 1 END,
                CASE tr.status
                    WHEN 'Starter' THEN 1
                    WHEN 'Substitute' THEN 2
                    WHEN 'Benched' THEN 3
                    ELSE 4
                END,
                ttr.player_steam_id
            LIMIT _max_players_per_lineup
        LOOP
            INSERT INTO match_lineup_players (match_lineup_id, steam_id)
            VALUES (_lineup.match_lineup_id, member.player_steam_id);
        END LOOP;

        IF _lineup.captain_steam_id IS NOT NULL THEN
            UPDATE match_lineup_players
            SET captain = true
            WHERE match_lineup_id = _lineup.match_lineup_id
              AND steam_id = _lineup.captain_steam_id;
        END IF;
    END LOOP;
END;
$$;
