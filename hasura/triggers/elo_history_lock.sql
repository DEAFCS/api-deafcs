-- DEAFCS ELO history lock guards (see hasura/functions/elo/elo_history_lock.sql).
-- With no lock in elo_history_locks every guard below lets everything through,
-- so nothing changes until an authorized activation.

-- The lock table itself is append-only.
CREATE OR REPLACE FUNCTION public.tbud_elo_history_locks_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'ELO history locks are permanent and cannot be changed or removed';
END;
$$;

DROP TRIGGER IF EXISTS tbud_elo_history_locks_append_only ON public.elo_history_locks;
CREATE TRIGGER tbud_elo_history_locks_append_only
    BEFORE UPDATE OR DELETE ON public.elo_history_locks
    FOR EACH ROW EXECUTE FUNCTION public.tbud_elo_history_locks_append_only();

-- player_elo rows from before the boundary can't be written, changed or
-- removed. One exception: deleting a player removes their own rows with the
-- account (the FK cascade runs after the player row is gone). Deleting a rated
-- match with locked rows is refused on matches itself (tbd_matches_elo_history).
CREATE OR REPLACE FUNCTION public.tbiud_player_elo_history_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _lock timestamptz := public.elo_history_locked_before();
BEGIN
    IF _lock IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at < _lock THEN
        IF TG_OP = 'DELETE' AND (
            NOT EXISTS (SELECT 1 FROM public.players p WHERE p.steam_id = OLD.steam_id)
            OR NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = OLD.match_id)
        ) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'ELO history before % is locked: the rating of match % cannot be changed', _lock, OLD.match_id
            USING ERRCODE = '22000';
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at < _lock THEN
        RAISE EXCEPTION 'ELO history before % is locked: no rating can be added for match %', _lock, NEW.match_id
            USING ERRCODE = '22000';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS tbiud_player_elo_history_lock ON public.player_elo;
CREATE TRIGGER tbiud_player_elo_history_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.player_elo
    FOR EACH ROW EXECUTE FUNCTION public.tbiud_player_elo_history_lock();

-- TRUNCATE skips row triggers: the old full recompute starts with one.
CREATE OR REPLACE FUNCTION public.tbt_player_elo_history_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF public.elo_history_locked_before() IS NOT NULL THEN
        RAISE EXCEPTION 'ELO history before % is locked: player_elo cannot be truncated', public.elo_history_locked_before()
            USING ERRCODE = '22000';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tbt_player_elo_history_lock ON public.player_elo;
CREATE TRIGGER tbt_player_elo_history_lock
    BEFORE TRUNCATE ON public.player_elo
    FOR EACH STATEMENT EXECUTE FUNCTION public.tbt_player_elo_history_lock();

-- Matches: stamp the 5v5 formula once (when the match starts, or ends without
-- starting) and never change it; refuse a void on a locked match. Named after
-- tbu_matches so it runs after that trigger has set started_at / ended_at.
CREATE OR REPLACE FUNCTION public.tbu_matches_elo_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.elo_version IS NOT NULL AND NEW.elo_version IS DISTINCT FROM OLD.elo_version THEN
        RAISE EXCEPTION 'The ELO formula of match % is fixed', OLD.id USING ERRCODE = '22000';
    END IF;

    IF NEW.elo_version IS NULL AND (NEW.started_at IS NOT NULL OR NEW.ended_at IS NOT NULL) THEN
        NEW.elo_version := public.elo_5v5_formula_version_at(COALESCE(NEW.started_at, NEW.ended_at));
    END IF;

    IF NEW.elo_voided IS DISTINCT FROM OLD.elo_voided AND public.match_elo_locked(OLD.id) THEN
        RAISE EXCEPTION 'Match % is part of the locked ELO history (before %); its ELO cannot be voided or restored',
            OLD.id, public.elo_history_locked_before() USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_matches_elo_history ON public.matches;
CREATE TRIGGER tbu_matches_elo_history
    BEFORE UPDATE ON public.matches
    FOR EACH ROW EXECUTE FUNCTION public.tbu_matches_elo_history();

-- A rated match in the locked history can't be deleted: its rows are part of
-- every later rating. Canceled matches (no winner) delete as before.
CREATE OR REPLACE FUNCTION public.tbd_matches_elo_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.winning_lineup_id IS NOT NULL
       AND public.elo_history_locked_before() IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.player_elo pe
            WHERE pe.match_id = OLD.id
              AND pe.created_at < public.elo_history_locked_before()
       )
    THEN
        RAISE EXCEPTION 'Match % is part of the locked ELO history (before %) and cannot be deleted',
            OLD.id, public.elo_history_locked_before() USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_matches_elo_history ON public.matches;
CREATE TRIGGER tbd_matches_elo_history
    BEFORE DELETE ON public.matches
    FOR EACH ROW EXECUTE FUNCTION public.tbd_matches_elo_history();
