-- First-come-first-served cap for individual sign-up tournaments
-- (match_options.individual_registration_enabled): once as many players
-- have registered as the first stage's max_teams * team size can hold,
-- anyone joining after that lands straight on the waitlist instead of
-- Registered -- rather than everyone staying "Registered" until
-- generateTournamentTeams sorts the overflow out at generation time.
CREATE OR REPLACE FUNCTION public.tbi_tournament_individual_signups() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _cap int;
    _registered_count int;
BEGIN
    IF NEW.status IS NULL OR NEW.status = 'Registered' THEN
        SELECT ts.max_teams * public.tournament_min_players_per_lineup(t)
        INTO _cap
        FROM public.tournaments t
        JOIN public.tournament_stages ts
            ON ts.tournament_id = t.id AND ts."order" = 1
        WHERE t.id = NEW.tournament_id;

        IF _cap IS NOT NULL THEN
            SELECT COUNT(*) INTO _registered_count
            FROM public.tournament_individual_signups
            WHERE tournament_id = NEW.tournament_id AND status = 'Registered';

            IF _registered_count >= _cap THEN
                NEW.status := 'Waitlisted';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_individual_signups ON public.tournament_individual_signups;
CREATE TRIGGER tbi_tournament_individual_signups
    BEFORE INSERT ON public.tournament_individual_signups
    FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_individual_signups();
