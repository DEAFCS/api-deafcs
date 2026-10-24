-- Only safe while no lock exists (nothing is protected yet). With a lock in
-- place, keep the table: dropping it removes the history protection.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.elo_history_locks) THEN
        RAISE EXCEPTION 'ELO history is locked; elo_history_locks cannot be dropped';
    END IF;
END $$;

DROP TRIGGER IF EXISTS tbiud_player_elo_history_lock ON public.player_elo;
DROP TRIGGER IF EXISTS tbt_player_elo_history_lock ON public.player_elo;
DROP TRIGGER IF EXISTS tbu_matches_elo_history ON public.matches;
DROP TRIGGER IF EXISTS tbd_matches_elo_history ON public.matches;
DROP TRIGGER IF EXISTS tbud_elo_history_locks_append_only ON public.elo_history_locks;
ALTER TABLE public.matches DROP COLUMN IF EXISTS elo_version;
ALTER TABLE public.player_elo
    DROP COLUMN IF EXISTS scale_factor,
    DROP COLUMN IF EXISTS elo_version;
DROP TABLE IF EXISTS public.elo_history_locks;
