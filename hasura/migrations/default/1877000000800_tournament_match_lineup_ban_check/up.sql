CREATE OR REPLACE FUNCTION public.is_admin_sanctioned(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM player_sanctions ps
        WHERE ps.player_steam_id = player.steam_id
        AND ps.type = 'ban'
        AND ps.deleted_at IS NULL
        AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
        AND ps.sanctioned_by_steam_id <> 0
    );
$$;

CREATE OR REPLACE FUNCTION public.tbid_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
    match_type text;
    is_tournament boolean;
    lineup_count INT;
    _max_players_per_lineup INT;
BEGIN
    SELECT mo.type, m.status, COALESCE(is_tournament_match(m), false)
        INTO match_type, status, is_tournament
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE ml.id = COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);

    IF TG_OP = 'INSERT' THEN
        IF (
            (is_tournament AND is_admin_sanctioned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
            OR (NOT is_tournament AND is_banned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
        ) THEN
            RAISE EXCEPTION 'Player is Currently Banned' USING ERRCODE = '22000';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        SELECT COUNT(*) INTO lineup_count
            FROM match_lineup_players
            WHERE match_lineup_id = OLD.match_lineup_id;

        IF ((status != 'PickingPlayers' AND status != 'Canceled') AND (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text != 'admin') THEN
            SELECT get_match_type_min_players(match_type) INTO _max_players_per_lineup;

            IF (lineup_count - 1) >= _max_players_per_lineup THEN
                RETURN OLD;
            END IF;

            RAISE EXCEPTION 'Cannot remove players: not enough players in lineup' USING ERRCODE = '22000';
        END IF;

        RETURN OLD;
    ELSE
        select check_match_lineup_players_count(NEW) into lineup_count;

        IF lineup_count = 0 THEN
            NEW.captain = true;
        END IF;

        PERFORM check_match_lineup_players(NEW);

        RETURN NEW;
    END IF;
END;
$$;
