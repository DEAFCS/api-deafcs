-- "Prepared, but not yet playable": true for a tournament match whose
-- tournament has finalized its participants (RegistrationClosed) but has not
-- reached its own scheduled start.
--
-- Round-1 matches are deliberately materialized ahead of kickoff
-- (CheckForScheduledTournamentBrackets runs a 15-minute window, and the
-- RegistrationClosed transition seeds the first stage immediately), so the
-- bracket, seeds and opponents are visible and teams can prepare. That
-- preparation window must not also make the match playable: before this
-- existed, a 12:20 tournament whose registration closed at 12:15 had a
-- fully open match at 12:15 -- match check-in, veto and the join/start flow
-- all worked five minutes before the tournament had begun.
--
-- Deliberately narrow: only RegistrationClosed counts. Once the tournament
-- is Live (CheckForTournamentStart flips it exactly at `start`), or an
-- organizer takes it Live early, this is false and every later round keeps
-- its existing immediate behavior -- as do league matches, which play out
-- while their season tournament is Live.
CREATE OR REPLACE FUNCTION public.tournament_match_is_pre_start(_match_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        INNER JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN public.tournaments t ON t.id = ts.tournament_id
        WHERE tb.match_id = _match_id
          AND t.status = 'RegistrationClosed'
          AND t.start IS NOT NULL
          AND t.start > now()
    );
$$;
