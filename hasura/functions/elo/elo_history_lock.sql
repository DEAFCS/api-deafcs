-- DEAFCS ELO history lock and formula versions.
--
-- elo_history_locks (migration 1891300000100) is append-only. The latest
-- locked_before is the boundary: every player_elo row created before it is
-- immutable history (enforced by hasura/triggers/elo_history_lock.sql), no
-- calculation, void or recompute may change it, and recomputes only rebuild
-- what came after it, starting from each player's last locked rating (never
-- from 5000). Each lock also names the 5v5 formula for matches that start at
-- or after it, which is how ELO v2 is activated.
--
-- Nothing here locks anything by itself: the first lock is inserted only by
-- an authorized activation (public.activate_elo_v2).
--
-- SQL functions (not plpgsql) where other SQL functions call them: this
-- directory loads before hasura/functions/match.

-- The boundary. Once ELO history is locked at all (the v2 activation), every
-- season that has started since closes the one before it automatically: at
-- Season 2's start (seasons.starts_at, already scheduled) all of Season 1
-- becomes permanent, with no manual step. Before any lock row exists nothing
-- is locked, whatever the seasons. (Settings read inline: seasons_enabled()
-- loads after this directory.)
CREATE OR REPLACE FUNCTION public.elo_history_locked_before()
RETURNS timestamptz
LANGUAGE sql STABLE
AS $$
    SELECT CASE
        WHEN l.locked IS NULL THEN NULL
        ELSE GREATEST(l.locked, COALESCE(s.started, l.locked))
    END
      FROM (SELECT max(locked_before) AS locked FROM public.elo_history_locks) l
      LEFT JOIN LATERAL (
          SELECT max(se.starts_at) AS started
            FROM public.seasons se
           WHERE se.starts_at <= now()
             AND COALESCE(
                 (SELECT st.value FROM public.settings st WHERE st.name = 'public.seasons_enabled'),
                 'false'
             ) = 'true'
      ) s ON true;
$$;

-- A rated match that ended in the last hour before the boundary but whose
-- ELO was never calculated (its job ran just after midnight, say) still gets
-- that first calculation, once; its rows are locked like the rest. Anything
-- else before the boundary stays as it is.
CREATE OR REPLACE FUNCTION public.elo_late_first_calculation(_match_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT public.elo_history_locked_before() IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.matches m
            WHERE m.id = _match_id
              AND m.ended_at < public.elo_history_locked_before()
              AND m.ended_at >= public.elo_history_locked_before() - interval '1 hour'
       )
       AND NOT EXISTS (SELECT 1 FROM public.player_elo pe WHERE pe.match_id = _match_id);
$$;

-- The 5v5 formula in effect at a moment: the latest lock at or before it, or
-- the original formula (1) before any lock.
CREATE OR REPLACE FUNCTION public.elo_5v5_formula_version_at(_ts timestamptz)
RETURNS smallint
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (SELECT l.formula_version
           FROM public.elo_history_locks l
          WHERE l.locked_before <= _ts
          ORDER BY l.locked_before DESC
          LIMIT 1),
        1::smallint
    );
$$;

-- The 5v5 formula a match is rated with: stamped on the match when it started
-- (matches.elo_version, see tbu_matches_elo_history), otherwise derived from
-- its own start (or end) time. Never from when the calculation happens to run.
CREATE OR REPLACE FUNCTION public.match_elo_version(match_record public.matches)
RETURNS smallint
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        match_record.elo_version,
        public.elo_5v5_formula_version_at(
            COALESCE(match_record.started_at, match_record.ended_at, match_record.created_at)
        )
    );
$$;

-- A match whose rating is locked history: it ended before the boundary, or it
-- already has rows from before it (e.g. an old match that was re-finished).
CREATE OR REPLACE FUNCTION public.match_elo_locked(_match_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT public.elo_history_locked_before() IS NOT NULL
       AND (
           EXISTS (
               SELECT 1 FROM public.matches m
                WHERE m.id = _match_id
                  AND m.ended_at < public.elo_history_locked_before()
           )
           OR EXISTS (
               SELECT 1 FROM public.player_elo pe
                WHERE pe.match_id = _match_id
                  AND pe.created_at < public.elo_history_locked_before()
           )
       );
$$;

-- One key for every writer of rated player_elo rows: the per-match
-- calculation and the boundary recompute take it for their transaction, so a
-- match finishing during a recompute waits for it instead of interleaving.
CREATE OR REPLACE FUNCTION public.elo_write_lock_key()
RETURNS bigint
LANGUAGE sql IMMUTABLE
AS $$ SELECT 72930410001::bigint; $$;

-- Adds a history lock. Only for an authorized operation (ELO v2 activation,
-- a season transition): it makes everything before _locked_before permanent.
-- Refuses a boundary in the future, one not after the current lock, and a
-- moment with rated matches whose ELO has not been calculated yet (they would
-- be frozen without a rating).
CREATE OR REPLACE FUNCTION public.lock_elo_history(
    _reason text,
    _formula_version smallint,
    _created_by_steam_id bigint DEFAULT NULL,
    _locked_before timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _current timestamptz;
    _pending integer;
    _id uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(public.elo_write_lock_key());

    IF _reason IS NULL OR btrim(_reason) = '' THEN
        RAISE EXCEPTION 'A reason is required to lock ELO history' USING ERRCODE = '22000';
    END IF;
    IF _locked_before > now() THEN
        RAISE EXCEPTION 'An ELO history lock cannot be set in the future (%)', _locked_before
            USING ERRCODE = '22000';
    END IF;

    _current := public.elo_history_locked_before();
    IF _current IS NOT NULL AND _locked_before <= _current THEN
        RAISE EXCEPTION 'ELO history is already locked up to %', _current USING ERRCODE = '22000';
    END IF;

    -- Rated matches that ended in the last day before the boundary with no
    -- ELO rows yet: their calculation is still queued.
    SELECT count(*) INTO _pending
      FROM public.matches m
     WHERE m.ended_at < _locked_before
       AND m.ended_at >= _locked_before - interval '1 day'
       AND m.winning_lineup_id IS NOT NULL
       AND m.source = '5stack'
       AND NOT m.elo_voided
       AND NOT EXISTS (SELECT 1 FROM public.player_elo pe WHERE pe.match_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM public.team_scrim_requests s WHERE s.match_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM public.draft_games d WHERE d.match_id = m.id AND d.elo_enabled = false);
    IF _pending > 0 THEN
        RAISE EXCEPTION '% rated match(es) ended before % without ELO yet; wait for their calculation',
            _pending, _locked_before USING ERRCODE = '22000';
    END IF;

    INSERT INTO public.elo_history_locks (locked_before, formula_version, reason, created_by_steam_id)
    VALUES (_locked_before, _formula_version, btrim(_reason), _created_by_steam_id)
    RETURNING id INTO _id;

    RETURN _id;
END;
$$;

-- The ELO v2 activation: locks every rating so far and rates 5v5 matches that
-- start from now on with formula 2. Run once, by an authorized operator.
CREATE OR REPLACE FUNCTION public.activate_elo_v2(
    _reason text,
    _created_by_steam_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.elo_history_locks WHERE formula_version = 2) THEN
        RAISE EXCEPTION 'ELO v2 is already active' USING ERRCODE = '22000';
    END IF;
    RETURN public.lock_elo_history(_reason, 2::smallint, _created_by_steam_id, now());
END;
$$;

-- Rebuilds every rated match after the boundary in end-time order, in one
-- transaction under the write lock. Locked history is never read for
-- rewriting: each match starts from the players' ratings as they stand
-- (their last locked rating, then the rebuilt rows). A no-show penalty row
-- (a canceled match, no winner) cannot be recalculated, so it is kept and
-- re-based on the rebuilt rating before it. Deterministic: the same data
-- always gives the same rows. Returns the number of matches rebuilt.
CREATE OR REPLACE FUNCTION public.recompute_elo_after_lock()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _lock timestamptz;
    _item record;
    _rebuilt integer := 0;
BEGIN
    PERFORM pg_advisory_xact_lock(public.elo_write_lock_key());

    _lock := public.elo_history_locked_before();
    IF _lock IS NULL THEN
        RAISE EXCEPTION 'ELO history is not locked; use the full recompute' USING ERRCODE = '22000';
    END IF;

    DELETE FROM public.player_elo pe
     USING public.matches m
     WHERE m.id = pe.match_id
       AND pe.created_at >= _lock
       AND m.winning_lineup_id IS NOT NULL
       AND NOT public.match_elo_locked(m.id);

    FOR _item IN
        SELECT 1 AS kind, m.id AS match_id, NULL::bigint AS steam_id, NULL::text AS elo_type, m.ended_at AS at
          FROM public.matches m
         WHERE m.ended_at >= _lock
           AND m.winning_lineup_id IS NOT NULL
           AND NOT public.match_elo_locked(m.id)
        UNION ALL
        SELECT 2, pe.match_id, pe.steam_id, pe."type", pe.created_at
          FROM public.player_elo pe
          JOIN public.matches m ON m.id = pe.match_id
         WHERE pe.created_at >= _lock
           AND m.winning_lineup_id IS NULL
        ORDER BY at, kind, match_id, steam_id
    LOOP
        IF _item.kind = 1 THEN
            PERFORM public.generate_player_elo_for_match(_item.match_id);
            _rebuilt := _rebuilt + 1;
        ELSE
            UPDATE public.player_elo pe
               SET current = GREATEST(0, COALESCE((
                       SELECT prior.current
                         FROM public.player_elo prior
                        WHERE prior.steam_id = pe.steam_id
                          AND prior."type" = pe."type"
                          AND prior.season_id IS NOT DISTINCT FROM pe.season_id
                          AND prior.created_at < pe.created_at
                          AND prior.match_id <> pe.match_id
                        ORDER BY prior.created_at DESC
                        LIMIT 1
                   ), 5000) + pe.change)
             WHERE pe.match_id = _item.match_id
               AND pe.steam_id = _item.steam_id
               AND pe."type" = _item.elo_type;
        END IF;
    END LOOP;

    RETURN _rebuilt;
END;
$$;
