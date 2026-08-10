-- Extends the tournament-only Sanction-vs-Abandoned ban check (see
-- 1877000000800_tournament_match_lineup_ban_check) to draft matches too.
-- Draft eligibility (draft-game.service.ts) was already fixed to only
-- block on a real admin Sanction, but the actual match_lineup_players
-- INSERT (fired when the draft match is created/started) still fell
-- through to the blanket is_banned check because is_tournament_match()
-- is false for a draft-originated match, blocking an Abandoned
-- (leaver/no-show) banned player from ever actually being added once the
-- draft attempted to start.
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

CREATE OR REPLACE FUNCTION public.tbid_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
    match_type text;
    is_tournament boolean;
    is_draft boolean;
    sanction_only boolean;
    lineup_count INT;
    _max_players_per_lineup INT;
BEGIN
    SELECT mo.type, m.status, COALESCE(is_tournament_match(m), false), COALESCE(is_draft_match(m), false)
        INTO match_type, status, is_tournament, is_draft
    FROM matches m
    INNER JOIN match_lineups ml ON ml.match_id = m.id
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE ml.id = COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);

    sanction_only := is_tournament OR is_draft;

    IF TG_OP = 'INSERT' THEN
        -- Tournament and draft matches only care about a real admin
        -- sanction, not an automatic leaver/no-show ban ("Abandoned") --
        -- MM keeps blocking on any active ban, same as before.
        IF (
            (sanction_only AND is_admin_sanctioned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
            OR (NOT sanction_only AND is_banned((SELECT p FROM players p WHERE steam_id = NEW.steam_id)))
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
