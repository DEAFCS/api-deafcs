-- Per-tournament Minimum Role, independent of the global
-- public.matchmaking_min_role setting. Gates team and individual
-- registration (see meets_min_role.sql). NULL means unrestricted; new
-- tournaments default to verified_user. There are no existing production
-- tournaments, so no backfill is needed.
ALTER TABLE public.tournaments
    ADD COLUMN min_role text DEFAULT 'verified_user'
        REFERENCES public.e_player_roles(value) ON UPDATE CASCADE ON DELETE RESTRICT;
