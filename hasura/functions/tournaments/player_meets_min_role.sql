-- Target-player eligibility gate for tournaments.min_role -- the counterpart
-- to meets_min_role.sql, which only checks the ACTING session. Reuses the
-- same is_above_role() ordering by wrapping the target player's stored role
-- in a synthetic session object, so there is still a single source of truth
-- for role order (no duplicated hierarchy). NULL min_role means
-- unrestricted; a player row that can't be found resolves to a NULL role,
-- which is_above_role already treats as denied (fails closed), same as an
-- unrecognized role string.
--
-- Takes tournament_id directly rather than a `tournaments` row: an earlier
-- version took a row parameter and the trigger resolved it via
-- `SELECT * INTO _tournament FROM tournaments WHERE id = NEW.tournament_id`,
-- which -- for reasons that didn't reproduce outside a BEFORE INSERT
-- trigger on tournament_team_roster and weren't worth chasing further --
-- intermittently found zero rows for a tournament_id that unquestionably
-- existed (a plain SELECT count(*) in the same trigger invocation found it
-- fine). Taking the id directly and doing the lookup in one plain SQL
-- statement sidesteps the PL/pgSQL row-INTO path entirely.
CREATE OR REPLACE FUNCTION public.player_meets_min_role(tournament_id uuid, player_steam_id bigint) RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT t.min_role IS NULL
        OR public.is_above_role(
            t.min_role,
            json_build_object(
                'x-hasura-role',
                (SELECT role FROM public.players WHERE steam_id = player_steam_id)
            )
        )
    FROM public.tournaments t
    WHERE t.id = tournament_id;
$$;

-- Hasura computed-field wrapper for tournament_team_roster: the row already
-- carries both tournament_id and player_steam_id, so no session argument is
-- needed -- usable directly inside insert/update `check` expressions to gate
-- on the row's own target player, independent of who is performing the
-- write.
CREATE OR REPLACE FUNCTION public.tournament_team_roster_target_meets_min_role(roster public.tournament_team_roster) RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $$
    SELECT public.player_meets_min_role(roster.tournament_id, roster.player_steam_id);
$$;
