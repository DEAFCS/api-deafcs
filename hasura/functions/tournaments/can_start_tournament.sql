CREATE OR REPLACE FUNCTION public.can_start_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status NOT IN ('Setup', 'RegistrationOpen', 'RegistrationClosed') THEN
        RETURN false;
    END IF;

    IF NOT tournament_has_min_teams(tournament) THEN
        -- A Free Agent tournament may still be short only because its pool is
        -- not drafted yet. This is an optimistic UPPER BOUND, there only so the
        -- Start button is not hidden for a field that can still be made: the
        -- decision itself is taken after the real draft when the tournament
        -- starts, and a genuinely short field is cancelled there.
        IF NOT (
            tournament.registration_version = 2
            AND tournament.registration_type IN ('free_agents', 'both')
            AND (
                SELECT COUNT(*) FROM tournament_teams tt
                 WHERE tt.tournament_id = tournament.id AND tt.eligible_at IS NOT NULL
            ) + COALESCE((
                SELECT COUNT(*) FROM tournament_free_agents fa
                 WHERE fa.tournament_id = tournament.id
                   AND fa.status IN ('registered', 'waitlisted')
            ) / NULLIF(tournament_min_players_per_lineup(tournament), 0), 0)
            >= COALESCE((
                SELECT SUM(ts.min_teams) FROM tournament_stages ts
                 WHERE ts.tournament_id = tournament.id AND ts."order" = 1
            ), 0)
        ) THEN
            RETURN false;
        END IF;
    END IF;

    RETURN public.is_tournament_organizer(tournament, hasura_session);
END;
$$;
