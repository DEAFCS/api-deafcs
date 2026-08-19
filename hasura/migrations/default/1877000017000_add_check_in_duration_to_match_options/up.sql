-- Independent Check-in Time duration (minutes), separate from
-- auto_cancel_duration (Match Cancellation Time). Tournament matches use
-- this for the WaitingForCheckIn deadline when check_in_setting is
-- Captains/Players; auto_cancel_duration continues to govern the later
-- Veto/cancellation deadline unchanged.
ALTER TABLE public.match_options
    ADD COLUMN check_in_duration integer CHECK (check_in_duration > 0);
