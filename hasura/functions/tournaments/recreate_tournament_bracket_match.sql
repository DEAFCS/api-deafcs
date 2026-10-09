-- Repair for a tournament bracket whose match row is gone.
--
-- tournament_brackets.match_id is ON DELETE SET NULL, so hard-deleting a match
-- (which the generic delete is no longer allowed to do for tournament matches)
-- leaves the bracket slot with both teams and no match:
--
--   * an UNFINISHED slot is picked up again by CheckForScheduledTournamentBrackets
--     once it has a schedule close enough, so nothing is lost;
--   * a FINISHED slot is skipped by every scheduler (finished = true), while its
--     winner already moved on downstream. There is no match to reset, so the only
--     way back is to play it again.
--
-- This recreates the match for such a slot through the normal scheduling path
-- (current match options, current starting-lineup rules) and, if the slot was
-- finished, unwinds it exactly like a winner reset: downstream slots it fed are
-- cleared and their unstarted matches removed. It refuses anything that is not a
-- plainly orphaned slot, and anything whose downstream matches have started, so
-- played history is never rewritten.
CREATE OR REPLACE FUNCTION public.recreate_tournament_bracket_match(
    _bracket_id uuid,
    _scheduled_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _bracket public.tournament_brackets%ROWTYPE;
    _stage_type text;
    _tournament_id uuid;
    _tournament_status text;
    _was_finished boolean;
    _new_match_id uuid;
BEGIN
    SELECT tb.* INTO _bracket
      FROM public.tournament_brackets tb
     WHERE tb.id = _bracket_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Bracket not found';
    END IF;

    SELECT ts.type, ts.tournament_id INTO _stage_type, _tournament_id
      FROM public.tournament_stages ts
     WHERE ts.id = _bracket.tournament_stage_id;

    SELECT t.status INTO _tournament_status
      FROM public.tournaments t
     WHERE t.id = _tournament_id;

    IF _bracket.match_id IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This bracket already has a match';
    END IF;

    IF _bracket.bye THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'A bye has no match to recreate';
    END IF;

    IF _bracket.tournament_team_id_1 IS NULL OR _bracket.tournament_team_id_2 IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Both teams have to be in the bracket before its match can be recreated';
    END IF;

    IF _tournament_status NOT IN ('RegistrationClosed', 'Live', 'Paused') THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The tournament is not running';
    END IF;

    IF _bracket.finished AND _stage_type NOT IN ('SingleElimination', 'DoubleElimination') THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Only an elimination stage match can be recreated after it was finished';
    END IF;

    -- Played history downstream stays as it is.
    IF EXISTS (
        WITH RECURSIVE chain AS (
            SELECT _bracket.id AS id
            UNION
            SELECT parent.id
              FROM chain
              JOIN public.tournament_brackets current_bracket ON current_bracket.id = chain.id
              JOIN public.tournament_brackets parent
                ON parent.id = current_bracket.parent_bracket_id
                OR parent.id = current_bracket.loser_parent_bracket_id
        )
        SELECT 1
          FROM chain
          JOIN public.tournament_brackets tb ON tb.id = chain.id
          JOIN public.matches m ON m.id = tb.match_id
         WHERE tb.id <> _bracket.id
           AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'A match downstream of this bracket has already started; reset it first';
    END IF;

    _was_finished := _bracket.finished;

    IF _was_finished THEN
        UPDATE public.tournament_brackets SET finished = false WHERE id = _bracket.id;
        SELECT tb.* INTO _bracket FROM public.tournament_brackets tb WHERE tb.id = _bracket_id;
    END IF;

    _new_match_id := public.schedule_tournament_match(_bracket);

    IF _new_match_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The match could not be created; set a schedule for this bracket first';
    END IF;

    -- The slot had been won: take the result back the way a winner reset does.
    IF _was_finished THEN
        PERFORM public.reset_tournament_match(_new_match_id, NULL, 'WaitingForCheckIn', NULL);
    END IF;

    IF _scheduled_at IS NOT NULL THEN
        UPDATE public.tournament_brackets SET scheduled_at = _scheduled_at WHERE id = _bracket_id;
    END IF;

    RETURN _new_match_id;
END;
$$;
