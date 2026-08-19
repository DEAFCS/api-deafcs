-- Mirrors resolve_match_auto_cancel: for a tournament match, the effective
-- check-in settings come from the tournament's own match_options row (so an
-- organizer changing it retroactively applies to not-yet-checked-in
-- matches), not the match's cloned copy. Returns no rows for a non-tournament
-- match, which tbu_matches() uses to fall back to today's
-- auto_cancellation/auto_cancel_duration-only behavior unchanged.
CREATE OR REPLACE FUNCTION resolve_match_check_in(_match_id uuid)
RETURNS TABLE(check_in_setting text, check_in_duration int) AS $$
DECLARE
    _tournament_mo_id uuid;
BEGIN
    SELECT t.match_options_id
    INTO _tournament_mo_id
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    INNER JOIN tournaments t        ON t.id = ts.tournament_id
    WHERE tb.match_id = _match_id;

    IF _tournament_mo_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT mo.check_in_setting, mo.check_in_duration
    FROM match_options mo
    WHERE mo.id = _tournament_mo_id;
END;
$$ LANGUAGE plpgsql STABLE;
