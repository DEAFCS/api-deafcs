CREATE OR REPLACE FUNCTION public.tbu_tournament_registration_match_options() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tournaments t WHERE t.match_options_id = OLD.id AND t.registration_version = 2) THEN
        IF NEW.individual_registration_enabled IS DISTINCT FROM OLD.individual_registration_enabled THEN
            RAISE EXCEPTION 'Tournament Random preset cannot change after creation';
        END IF;
        IF NEW.individual_registration_enabled AND NEW.type <> 'Competitive' THEN
            RAISE EXCEPTION 'Random tournaments require Competitive 5v5';
        END IF;
        IF NEW.type IS DISTINCT FROM OLD.type
            AND EXISTS (SELECT 1 FROM public.tournaments t WHERE t.match_options_id = OLD.id AND t.registration_version = 2
                AND (t.status NOT IN ('Setup', 'RegistrationOpen') OR public.tournament_check_in_window_opened(t))) THEN
            RAISE EXCEPTION 'Tournament lineup and rating mode are frozen after registration/check-in';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tbu_tournament_registration_match_options ON public.match_options;
CREATE TRIGGER tbu_tournament_registration_match_options BEFORE UPDATE ON public.match_options
FOR EACH ROW EXECUTE FUNCTION public.tbu_tournament_registration_match_options();
