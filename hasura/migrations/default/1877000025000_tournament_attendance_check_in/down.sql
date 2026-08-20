ALTER TABLE public.tournament_teams
    DROP COLUMN IF EXISTS checked_in_at;

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS attendance_check_in_open_before_minutes,
    DROP COLUMN IF EXISTS attendance_check_in_close_before_minutes;
