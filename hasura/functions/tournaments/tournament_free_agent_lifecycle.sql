-- Lifecycle helpers for tournaments that take Free Agents (registration_version
-- 2, registration_type free_agents or both).
--
-- tournament_has_min_teams counts the teams that EXIST. In those tournaments a
-- complete team can still be only a handful of eligible Free Agents until the
-- draft turns the pool into tournament_teams, so any decision to cancel for too
-- few teams has to see the real draft's result first. Never an estimate such as
-- pool / team size: parties, eligibility, check-in, the stage cap and players
-- who are already rostered all change how many teams actually pack, so the draft
-- itself stays the only authority.

-- Would the tournament have its minimum number of teams once the Free Agent pool
-- is drafted? Runs the REAL draft inside a sub-transaction, counts the result and
-- rolls the draft back, so it never creates teams and can be asked at any time.
-- Anything that does not draft is answered from the teams that exist.
CREATE OR REPLACE FUNCTION public.tournament_would_have_min_teams(_tournament_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _ok boolean;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF _tournament.registration_version = 2
       AND _tournament.registration_type IN ('free_agents', 'both')
       AND _tournament.status IN ('Setup', 'RegistrationOpen', 'CheckInReview') THEN
        BEGIN
            PERFORM public.draft_tournament_free_agent_teams(_tournament_id);

            SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = _tournament_id;
            _ok := public.tournament_has_min_teams(_tournament);

            -- Always undone: this only asks. A plpgsql variable keeps its value
            -- through the rollback of the block that assigned it.
            RAISE EXCEPTION 'draft probe' USING ERRCODE = 'DF001';
        EXCEPTION
            WHEN SQLSTATE 'DF001' THEN
                NULL;
        END;

        RETURN COALESCE(_ok, false);
    END IF;

    RETURN public.tournament_has_min_teams(_tournament);
END;
$$;

-- The automatic "not enough teams" cancellation at the scheduled start. An open
-- tournament whose existing teams fall short is only cancelled when the drafted
-- Free Agent teams would not make up the difference either. Otherwise it is left
-- for the organizer to close or start, where the real draft runs before the
-- bracket. Returns the number of tournaments cancelled.
CREATE OR REPLACE FUNCTION public.cancel_invalid_tournaments()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    _candidate record;
    _cancelled integer := 0;
BEGIN
    FOR _candidate IN
        SELECT t.id
          FROM public.tournaments t
         WHERE t.status = 'RegistrationOpen'
           AND t.start <= now()
           AND NOT public.tournament_has_min_teams(t)
    LOOP
        BEGIN
            -- Serializes against a sign-up, a close or another run.
            PERFORM 1 FROM public.tournaments t
             WHERE t.id = _candidate.id AND t.status = 'RegistrationOpen'
               FOR UPDATE;

            IF NOT FOUND THEN
                CONTINUE;
            END IF;

            IF NOT public.tournament_would_have_min_teams(_candidate.id) THEN
                UPDATE public.tournaments
                   SET status = 'CancelledMinTeams'
                 WHERE id = _candidate.id AND status = 'RegistrationOpen';
                _cancelled := _cancelled + 1;
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                -- Never cancel on a failure to find out; the next pass asks again.
                RAISE WARNING 'cancel_invalid_tournaments: % skipped: %', _candidate.id, SQLERRM;
        END;
    END LOOP;

    RETURN _cancelled;
END;
$$;

-- Reset to Setup returns a cancelled tournament to a reusable pre-registration
-- state. Teams that registered stay (they are real registrations), but what the
-- Free Agent draft generated does not: the generated teams go, and everyone the
-- draft placed or waitlisted goes back to the pool, so the next close drafts the
-- pool again. Seeds belong to a closed field and are cleared; eligibility is
-- recomputed from the rosters as always.
CREATE OR REPLACE FUNCTION public.reset_tournament_generated_state(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Back into the pool BEFORE the generated teams are deleted, so deleting a
    -- roster row has no drafted entry to withdraw and no waitlisted one to promote.
    UPDATE public.tournament_free_agents fa
       SET status = CASE
               WHEN fa.status = 'drafted' THEN 'registered'
               WHEN public.player_meets_tournament_requirements(fa.tournament_id, fa.player_steam_id)
                   THEN 'registered'
               ELSE 'withdrawn'
           END,
           tournament_team_id = NULL
     WHERE fa.tournament_id = _tournament_id
       AND fa.status IN ('drafted', 'waitlisted');

    DELETE FROM public.tournament_teams tt
     WHERE tt.tournament_id = _tournament_id AND tt.is_drafted;

    UPDATE public.tournament_teams
       SET seed = NULL
     WHERE tournament_id = _tournament_id AND seed IS NOT NULL;
END;
$$;
