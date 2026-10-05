-- Adapted from 5Stack API c23d08084075e620387cebeabb2fa62e2b78f828; MIT Copyright (c) 2025 5Stack.gg; see LICENSE.
-- Whether the tournament may be held in CheckInReview right now: registration is
-- open, check-in is actually in force, and the caller organizes it.
--
-- Returns NULL, not false, for a session-less caller, exactly like the other
-- can_* guards -- the check-in job writes with no hasura.user and `IF NOT NULL`
-- does not raise, which is how every system-side status flip already works.
CREATE OR REPLACE FUNCTION public.can_review_tournament_check_in(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'RegistrationOpen' THEN
        RETURN false;
    END IF;

    IF NOT tournament.check_in_required THEN
        RETURN false;
    END IF;

    RETURN is_tournament_organizer(tournament, hasura_session);
END;
$$;
