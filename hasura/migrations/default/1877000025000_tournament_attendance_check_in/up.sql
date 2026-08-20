-- Shared "tournament attendance" check-in timing, for both individual
-- (Solo Random) and normal team tournaments. Reuses the existing
-- tournaments.individual_check_in_ends_at / individual_check_in_duration_minutes
-- pair (previously Solo Random-only) as the single attendance-window signal
-- for both participant shapes -- these two new columns are just the
-- configurable inputs an automatic scheduler derives that window from.
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS attendance_check_in_open_before_minutes integer NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS attendance_check_in_close_before_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE public.tournaments
    ADD CONSTRAINT tournaments_attendance_open_before_range
        CHECK (attendance_check_in_open_before_minutes BETWEEN 15 AND 240),
    ADD CONSTRAINT tournaments_attendance_close_before_range
        CHECK (attendance_check_in_close_before_minutes BETWEEN 5 AND 60),
    ADD CONSTRAINT tournaments_attendance_open_after_close
        CHECK (attendance_check_in_open_before_minutes > attendance_check_in_close_before_minutes),
    ADD CONSTRAINT tournaments_attendance_min_gap
        CHECK (attendance_check_in_open_before_minutes - attendance_check_in_close_before_minutes >= 5);

-- Team-tournament attendance check-in (captain/authorized representative
-- confirms the team is attending). Mirrors
-- tournament_individual_signups.checked_in_at -- same "present" signal,
-- different participant shape; deliberately not match check-in (matches.*),
-- which stays untouched.
ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
