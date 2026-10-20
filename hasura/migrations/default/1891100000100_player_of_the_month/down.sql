-- Rollback for 1891100000100_player_of_the_month.
--
-- Refuses to run once any Player of the Month award exists: approved awards
-- are permanent award history and must never be dropped by a rollback. In
-- that case roll back the API/WEB only and leave this schema in place.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.award_occurrences o
          JOIN public.awards a ON a.id = o.award_id
         WHERE a.system_key = 'player_of_the_month'
    ) THEN
        RAISE EXCEPTION 'Player of the Month awards exist; refusing to drop their review history';
    END IF;
END $$;

DROP TRIGGER IF EXISTS tbud_player_of_the_month_review_events_append_only
    ON public.player_of_the_month_review_events;
DROP FUNCTION IF EXISTS public.tbud_player_of_the_month_review_events_append_only();
DROP TABLE IF EXISTS public.player_of_the_month_review_events;
DROP TABLE IF EXISTS public.player_of_the_month_reviews;
-- tbd_awards_guard refuses to delete a built-in (system_key) award; with no
-- occurrence (checked above) tbu_awards_guard allows clearing the key first.
DO $$
DECLARE
    v_award uuid;
BEGIN
    SELECT id INTO v_award FROM public.awards WHERE system_key = 'player_of_the_month';
    IF v_award IS NOT NULL THEN
        UPDATE public.awards SET system_key = NULL WHERE id = v_award;
        DELETE FROM public.awards WHERE id = v_award;
    END IF;
END $$;
