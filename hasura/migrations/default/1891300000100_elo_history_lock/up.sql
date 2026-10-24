-- DEAFCS ELO history lock + formula versioning (ELO v2 for rated 5v5).
--
-- Additive only: no existing row is changed. Nothing is locked and no match
-- uses the new formula until an authorized activation inserts the first
-- elo_history_locks row (public.activate_elo_v2, see
-- hasura/functions/elo/elo_history_lock.sql).
--
-- elo_history_locks: append-only. Every player_elo row created before the
-- latest locked_before is immutable (guards in hasura/triggers/
-- elo_history_lock.sql). formula_version is the 5v5 formula for matches that
-- start at or after locked_before. A later lock (e.g. the Season 2 start)
-- adds a row; earlier rows are never edited or removed.
CREATE TABLE IF NOT EXISTS public.elo_history_locks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    locked_before timestamptz NOT NULL UNIQUE,
    formula_version smallint NOT NULL CHECK (formula_version IN (1, 2)),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    created_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Which formula produced a player_elo row (1 = the original formula, 2 = 5v5
-- ELO v2) and its expected-score scale. Existing rows read as version 1; their
-- scale (4000) is implied, so scale_factor stays NULL on them.
ALTER TABLE public.player_elo
    ADD COLUMN IF NOT EXISTS elo_version smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS scale_factor integer;

-- The 5v5 formula a match is rated with, stamped once when it starts (or
-- ends, if it never started): a match already underway when v2 is activated
-- keeps version 1 even if it finishes afterwards. NULL on every existing
-- match; the calculation then derives it from the match's own start time.
ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS elo_version smallint;
