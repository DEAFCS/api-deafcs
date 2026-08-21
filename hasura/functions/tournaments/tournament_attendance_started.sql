-- Has this tournament's attendance check-in window opened yet?
--
-- Mirrors the frontend's attendanceCheckInOpened() exactly: either the
-- scheduler has already stamped individual_check_in_ends_at, or the derived
-- open time (start minus attendance_check_in_open_before_minutes) has been
-- reached. The 60-minute default matches DEFAULT_OPEN_BEFORE_MINUTES on the
-- web side and the column default.
--
-- Naturally one-way for the tournament's life: once `start - offset` is in the
-- past it stays there, so the schedule never quietly becomes editable again
-- after the window has closed.
--
-- Deliberately takes a `tournaments` row rather than an id so callers can pass
-- OLD from a trigger. That matters: the freeze must be decided from the
-- PERSISTED schedule, never the proposed one, or an organizer could escape the
-- lock by moving the start into the future in the same statement.
CREATE OR REPLACE FUNCTION public.tournament_attendance_started(
    tournament public.tournaments
) RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        tournament.individual_check_in_ends_at IS NOT NULL
        OR (
            tournament.start IS NOT NULL
            AND now() >= tournament.start
                - (COALESCE(tournament.attendance_check_in_open_before_minutes, 60)::text
                   || ' minutes')::interval
        );
$$;
