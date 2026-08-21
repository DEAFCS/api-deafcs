-- Belt-and-suspenders cleanup for orphaned Awards Phase A objects. These
-- three names (tau_tournaments_awards, tbi_award_recipients, tbd_awards)
-- were an earlier iteration of what's now tau_tournaments_trophies() /
-- award_recipients.sql / awards.sql, renamed away before this migration
-- landed -- hasura/migrations/default/1873000000700_awards_phase_a/down.sql
-- already knows to drop them on rollback, but the forward-deploy path never
-- did, so any environment where they were ever created (schema-current or
-- not) still has them bound and firing. They reference the pre-refactor
-- award_recipients.tournament_id/.source columns (folded into
-- award_occurrences during this same migration), so when they fire they
-- fail with "column ... does not exist" -- notably inside
-- reset_tournament_match()'s Finished -> Live transition on tournaments.
-- The boot loader skips re-applying a file whose content hash is
-- unchanged, so this can't be fixed by simply redeploying the unchanged
-- current triggers -- editing this file (as this comment does) bumps the
-- hash and forces the cleanup below to actually run.
DROP TRIGGER IF EXISTS tau_tournaments_awards ON public.tournaments;
DROP FUNCTION IF EXISTS public.tau_tournaments_awards();

-- tbi_award_recipients predates the 0700 migration's
-- `ALTER TABLE award_recipients RENAME TO legacy_award_recipients_phase_a`
-- (up.sql:430), so its trigger binding moved with the table rename rather
-- than staying on the current public.award_recipients (the table that
-- migration re-creates fresh, unrelated to the pre-refactor one). Confirmed
-- against production: the live trigger is on
-- public.legacy_award_recipients_phase_a, not public.award_recipients.
-- legacy_award_recipients_phase_a is a permanent, intentionally-kept
-- historical copy of pre-migration award/trophy rows -- every database that
-- has applied 0700 has this table (fresh or upgraded alike) -- so this is
-- not a guess at an occasionally-present relation. `IF EXISTS` still
-- applies to a missing relation, not just a missing trigger name, so this
-- remains a no-op on any database that predates 0700.
DROP TRIGGER IF EXISTS tbi_award_recipients ON public.legacy_award_recipients_phase_a;
DROP FUNCTION IF EXISTS public.tbi_award_recipients();

DROP TRIGGER IF EXISTS tbd_awards ON public.awards;
DROP FUNCTION IF EXISTS public.tbd_awards();

CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    first_stage_id uuid;
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
    -- Capture the roster exactly once when registration closes or a
    -- tournament starts directly. Reopening registration clears the old
    -- capture before the existing stage rebuild/early return below.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status IN ('Setup', 'RegistrationOpen') THEN
            PERFORM public.clear_tournament_roster_image_snapshots(NEW.id);
        ELSIF NEW.status IN ('RegistrationClosed', 'Live')
              AND OLD.status IN ('Setup', 'RegistrationOpen') THEN
            PERFORM public.capture_tournament_roster_image_snapshots(NEW.id);
        END IF;
    END IF;

    -- Release the pre-start parking the moment the tournament actually
    -- starts. Matches materialized during RegistrationClosed sit in
    -- 'Scheduled' (see tournament_match_is_pre_start / tbu_matches); without
    -- this they would wait up to a full minute for the next
    -- CheckForScheduledMatches pass, leaving the tournament reading "Live"
    -- while its first-round matches still showed as merely scheduled.
    --
    -- Bounded to matches due around the tournament's own kickoff (the same
    -- 15-minute window CheckForScheduledMatches uses), so this only opens
    -- what the guard actually parked: a bracket carrying its own explicit,
    -- far-later schedule -- a league's negotiated fixture, an admin-mode
    -- bracket -- keeps waiting for its own time.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live' THEN
        UPDATE matches m
           SET status = 'WaitingForCheckIn'
         WHERE m.status = 'Scheduled'
           AND m.scheduled_at IS NOT NULL
           AND m.scheduled_at <= COALESCE(NEW.start, now()) + interval '15 minutes'
           AND EXISTS (
               SELECT 1
               FROM tournament_brackets tb
               INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
               WHERE tb.match_id = m.id
                 AND ts.tournament_id = NEW.id
           );
    END IF;

    IF (
         NEW.status IS DISTINCT FROM OLD.status AND
         NEW.status IN ('RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        return NEW;
    END IF;

    IF (
        NEW.status IS DISTINCT FROM OLD.status AND
        NEW.status IN ('Live', 'RegistrationClosed') AND
        OLD.status IN ('Setup', 'RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        PERFORM assign_seeds_to_teams(NEW);
        
        SELECT id INTO first_stage_id
        FROM tournament_stages
        WHERE tournament_id = NEW.id AND "order" = 1
        LIMIT 1;
        
        IF first_stage_id IS NOT NULL THEN
            PERFORM seed_stage(first_stage_id);
        END IF;
    END IF;

    -- When tournament resumes from Paused, schedule all ready brackets (only if auto_start)
    IF (
        NEW.status IS DISTINCT FROM OLD.status AND
        OLD.status = 'Paused' AND NEW.status = 'Live'
        AND NEW.auto_start
    ) THEN
        -- Resolve runtime byes first (one team, no pending feeders)
        -- Process lower rounds first so cascading byes propagate correctly
        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.bye = false
              AND ((tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NULL)
                OR (tb.tournament_team_id_1 IS NULL AND tb.tournament_team_id_2 IS NOT NULL))
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM resolve_bracket_bye(bracket_row);
        END LOOP;

        -- Then schedule matches with both teams present
        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.tournament_team_id_1 IS NOT NULL
              AND tb.tournament_team_id_2 IS NOT NULL
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM schedule_tournament_match(bracket_row);
        END LOOP;

        PERFORM calculate_tournament_bracket_start_times(NEW.id);
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();

CREATE OR REPLACE FUNCTION public.tad_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM cleanup_orphaned_match_options(OLD.match_options_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournaments ON public.tournaments;
CREATE TRIGGER tad_tournaments AFTER DELETE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tad_tournaments();


CREATE OR REPLACE FUNCTION public.tbu_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- The attendance schedule freezes once check-in has opened.
    --
    -- start, attendance_check_in_open_before_minutes and
    -- attendance_check_in_close_before_minutes together define the window the
    -- scheduler (ProcessTournamentAttendance) and every registered participant
    -- are already acting on. Editing any of them mid-window retroactively
    -- moves an active deadline, which is exactly the confusing state live
    -- testing produced. The UI disables these fields, but the Hasura update
    -- permission for `user`/`tournament_organizer` exposes all three columns
    -- behind nothing more than is_organizer, so the UI alone is not a control.
    --
    -- Evaluated against OLD on purpose: deciding from NEW would let an
    -- organizer move the start into the future in the same statement and
    -- thereby recalculate the window out of the frozen period, escaping the
    -- lock. The persisted schedule is what determines whether it is frozen.
    --
    -- Applies to every tournament using attendance, team and Solo Random
    -- alike -- this is about the attendance window, not registration type. No
    -- system path writes these columns after creation (the jobs only touch
    -- status and individual_check_in_ends_at), so this can only ever reject an
    -- organizer edit.
    IF (
           NEW.start IS DISTINCT FROM OLD.start
        OR NEW.attendance_check_in_open_before_minutes
             IS DISTINCT FROM OLD.attendance_check_in_open_before_minutes
        OR NEW.attendance_check_in_close_before_minutes
             IS DISTINCT FROM OLD.attendance_check_in_close_before_minutes
       )
       AND public.tournament_attendance_started(OLD) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Schedule and check-in timing cannot be changed after check-in has started';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- A league owns the lifecycle of its division/playoff tournaments;
        -- resetting or cancelling one directly corrupts the season. Only allow
        -- it when the league season cascade sets the bypass (season cancel).
        IF NEW.status IN ('Setup', 'Cancelled')
           AND current_setting('fivestack.league_cascade', true) IS DISTINCT FROM 'true'
           AND public.is_league_tournament(OLD.id) THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'This tournament belongs to a league; cancel or delete the league season instead';
        END IF;

        CASE NEW.status
            WHEN 'Setup' THEN
                IF NOT can_setup_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot reset tournament to setup';
                END IF;
            WHEN 'Cancelled' THEN
                IF NOT can_cancel_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            WHEN 'RegistrationOpen' THEN
                IF NOT can_open_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot open tournament registration';
                END IF;
            WHEN 'RegistrationClosed' THEN
                IF NOT can_close_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot close tournament registration';
                END IF;
            WHEN 'Live' THEN
                IF OLD.status = 'Paused' THEN
                    IF NOT can_resume_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot resume tournament';
                    END IF;
                ELSE
                    IF NOT tournament_has_min_teams(NEW) THEN
                        NEW.status = 'CancelledMinTeams';
                    END IF;
                END IF;
            WHEN 'Paused' THEN
                IF NOT can_pause_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot pause tournament';
                END IF;
            WHEN 'Finished' THEN
                IF NOT (
                    (current_setting('hasura.user', true)::json->>'x-hasura-role') IN ('admin', 'administrator')
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Tournament finish is handled automatically';
                END IF;
            ELSE
                -- No action needed for other status changes
        END CASE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournaments ON public.tournaments;
CREATE TRIGGER tbu_tournaments
    BEFORE UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_tournaments();

CREATE OR REPLACE FUNCTION public.tbd_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Backstop the API-action guard: a league's division/playoff tournament may
    -- only be removed via the league season (which sets the bypass). Deleting
    -- one directly orphans the league season's schedule and standings.
    IF current_setting('fivestack.league_cascade', true) IS DISTINCT FROM 'true'
       AND public.is_league_tournament(OLD.id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament belongs to a league; cancel or delete the league season instead';
    END IF;

    DELETE FROM tournament_stages
        WHERE tournament_id = OLD.id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournaments ON public.tournaments;
CREATE TRIGGER tbd_tournaments
    BEFORE DELETE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_tournaments();

CREATE OR REPLACE FUNCTION public.tbi_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.discord_notifications_enabled IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM public.settings
            WHERE name LIKE 'discord_match_notify_%'
              AND value = 'true'
        ) THEN
            NEW.discord_notifications_enabled := true;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournaments ON public.tournaments;
CREATE TRIGGER tbi_tournaments
    BEFORE INSERT ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_tournaments();

CREATE OR REPLACE FUNCTION public.tau_tournaments_trophies() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'Finished' AND OLD.status IS DISTINCT FROM 'Finished' THEN
        PERFORM public.calculate_tournament_awards(NEW.id);
    ELSIF OLD.status = 'Finished' AND NEW.status IS DISTINCT FROM 'Finished' THEN
        -- Manual awards survive status rollbacks; only the auto-calculated
        -- placements drop so recalc can reseat them on the next finish.
        PERFORM public.clear_tournament_calculated_awards(OLD.id);
    END IF;

    -- Trophies toggle: clearing it wipes the auto placements; turning it
    -- back on for a finished tournament rebuilds them.
    IF NEW.trophies_enabled IS DISTINCT FROM OLD.trophies_enabled THEN
        IF NEW.trophies_enabled = false THEN
            PERFORM public.clear_tournament_calculated_awards(NEW.id);
        ELSIF NEW.status = 'Finished' THEN
            PERFORM public.calculate_tournament_awards(NEW.id);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments_trophies ON public.tournaments;
CREATE TRIGGER tau_tournaments_trophies
    AFTER UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_tournaments_trophies();
