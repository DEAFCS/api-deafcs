CREATE OR REPLACE FUNCTION public.can_reassign_winner(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _parent_bracket_id uuid;
    _loser_parent_bracket_id uuid;
    blocking_downstream int;
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status NOT IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    SELECT parent_bracket_id, loser_parent_bracket_id
    INTO _parent_bracket_id, _loser_parent_bracket_id
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN true;
    END IF;

    -- parent_bracket_id / loser_parent_bracket_id point *forward* to the
    -- downstream bracket(s) this match's winner/loser advances into (see
    -- link_round_group_matches.sql, generate_double_elimination_bracket.sql).
    -- Reassignment is only safe while that immediate downstream match (if it
    -- already exists) hasn't progressed beyond an unplayed state.
    SELECT count(*) INTO blocking_downstream
    FROM tournament_brackets tb
    LEFT JOIN matches m ON m.id = tb.match_id
    WHERE tb.id IN (_parent_bracket_id, _loser_parent_bracket_id)
      AND m.id IS NOT NULL
      AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled');

    RETURN blocking_downstream = 0;
END;
$$;
