CREATE OR REPLACE FUNCTION public.refresh_tournament_match_lineup_teams(bracket public.tournament_brackets) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    match matches;
    _lineup RECORD;
    _max_players_per_lineup int;
    _captain_steam_id bigint;
    _desired bigint[];
    _old_extra_ids uuid[];
    _new_extra_steam_ids bigint[];
    _pair_count int;
    i int;
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

    -- The STARTING size, not starters plus substitutes: a match lineup holds
    -- the active players only (see match_starting_lineup.sql).
    SELECT match_min_players_per_lineup(match) INTO _max_players_per_lineup;

    FOR _lineup IN
        SELECT * FROM (VALUES
            (match.lineup_1_id, bracket.tournament_team_id_1),
            (match.lineup_2_id, bracket.tournament_team_id_2)
        ) AS l(match_lineup_id, tournament_team_id)
    LOOP
        UPDATE match_lineups
           SET team_id = (
               SELECT tt.team_id FROM tournament_teams tt WHERE tt.id = _lineup.tournament_team_id
           )
         WHERE match_lineups.id = _lineup.match_lineup_id;

        IF _lineup.tournament_team_id IS NULL THEN
            -- Slot vacated entirely (no team) -- an empty lineup is the
            -- correct end state, and the match hasn't been played, so
            -- clearing it outright is safe.
            DELETE FROM match_lineup_players WHERE match_lineup_id = _lineup.match_lineup_id;
            CONTINUE;
        END IF;

        SELECT tt.captain_steam_id INTO _captain_steam_id
        FROM tournament_teams tt WHERE tt.id = _lineup.tournament_team_id;

        -- Players already seated stay seated (right after the captain), so a
        -- roster change elsewhere never undoes the starting lineup the team
        -- chose; only a seat whose player left the roster is refilled.
        _desired := public.tournament_default_starters(
            _lineup.tournament_team_id,
            _lineup.match_lineup_id,
            _max_players_per_lineup
        );

        -- Rows currently seated in this lineup that the new roster doesn't
        -- want, oldest-steam-id-first for determinism -- these are the ones
        -- available to repurpose.
        SELECT COALESCE(array_agg(mlp.id ORDER BY mlp.steam_id), ARRAY[]::uuid[]) INTO _old_extra_ids
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = _lineup.match_lineup_id
          AND mlp.steam_id != ALL(_desired);

        -- Desired players not already seated in this lineup.
        SELECT COALESCE(array_agg(s ORDER BY s), ARRAY[]::bigint[]) INTO _new_extra_steam_ids
        FROM unnest(_desired) AS s
        WHERE s NOT IN (
            SELECT steam_id FROM match_lineup_players WHERE match_lineup_id = _lineup.match_lineup_id
        );

        -- Re-seat as many displaced rows as possible by updating steam_id in
        -- place rather than deleting-then-inserting. This changes row
        -- *content*, not row *count*, so it never trips
        -- match_lineup_players' insert/delete guards (minimum roster size on
        -- delete, maximum roster size on insert) -- unlike delete-then-insert,
        -- it's safe even when a lineup already sits exactly at its min/max
        -- (e.g. Duel, where min = max = 1).
        _pair_count := LEAST(
            COALESCE(array_length(_old_extra_ids, 1), 0),
            COALESCE(array_length(_new_extra_steam_ids, 1), 0)
        );

        IF _pair_count > 0 THEN
            FOR i IN 1.._pair_count LOOP
                -- checked_in is cleared: the seat now belongs to a different
                -- player, who must not inherit the previous player's check-in.
                UPDATE match_lineup_players
                   SET steam_id = _new_extra_steam_ids[i],
                       checked_in = false
                 WHERE id = _old_extra_ids[i];
            END LOOP;
        END IF;

        -- New team has more available players than the old lineup had slots
        -- to repurpose -- insert the rest. This only ever grows the lineup,
        -- so it's safe even at this point.
        IF COALESCE(array_length(_new_extra_steam_ids, 1), 0) > _pair_count THEN
            FOR i IN (_pair_count + 1)..array_length(_new_extra_steam_ids, 1) LOOP
                INSERT INTO match_lineup_players (match_lineup_id, steam_id)
                VALUES (_lineup.match_lineup_id, _new_extra_steam_ids[i]);
            END LOOP;
        END IF;

        -- Old lineup had more displaced players than the new team could
        -- fill via swapping -- drop the true surplus. Every desired player
        -- is already seated by this point, so this only ever removes rows
        -- down to the final (>= minimum, for a validly rostered team) size.
        IF COALESCE(array_length(_old_extra_ids, 1), 0) > _pair_count THEN
            FOR i IN (_pair_count + 1)..array_length(_old_extra_ids, 1) LOOP
                DELETE FROM match_lineup_players WHERE id = _old_extra_ids[i];
            END LOOP;
        END IF;

        PERFORM public.tournament_set_lineup_captain(
            _lineup.match_lineup_id,
            _captain_steam_id
        );

        -- A confirmation covers the players that were confirmed: when a seat
        -- changed hands because the roster changed, the team confirms again.
        IF _pair_count > 0
           OR COALESCE(array_length(_new_extra_steam_ids, 1), 0) > 0
           OR COALESCE(array_length(_old_extra_ids, 1), 0) > 0 THEN
            UPDATE match_lineups
               SET starting_lineup_confirmed_at = NULL
             WHERE id = _lineup.match_lineup_id;
        END IF;
    END LOOP;
END;
$$;
