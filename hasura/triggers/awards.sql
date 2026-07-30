CREATE OR REPLACE FUNCTION public.tbu_awards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.system_key IS NOT NULL AND (NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.archived_by IS DISTINCT FROM OLD.archived_by) THEN
    RAISE EXCEPTION 'Built-in awards cannot be archived';
  END IF;
  IF EXISTS (SELECT 1 FROM public.award_occurrences WHERE award_id=OLD.id) AND
     (NEW.tier IS DISTINCT FROM OLD.tier OR NEW.system_key IS DISTINCT FROM OLD.system_key OR
      NEW.allow_multiple IS DISTINCT FROM OLD.allow_multiple OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id OR
      NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.elo_season_id IS DISTINCT FROM OLD.elo_season_id OR
      NEW.league_season_id IS DISTINCT FROM OLD.league_season_id) THEN
    RAISE EXCEPTION 'Historical award identity fields cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.tbd_awards_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.system_key IS NOT NULL THEN RAISE EXCEPTION 'Built-in awards cannot be deleted'; END IF;
  IF EXISTS (SELECT 1 FROM public.award_occurrences WHERE award_id=OLD.id) THEN RAISE EXCEPTION 'Used awards must be archived, not deleted'; END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS tbu_awards_guard ON public.awards;
CREATE TRIGGER tbu_awards_guard BEFORE UPDATE ON public.awards FOR EACH ROW EXECUTE FUNCTION public.tbu_awards_guard();
DROP TRIGGER IF EXISTS tbd_awards_guard ON public.awards;
CREATE TRIGGER tbd_awards_guard BEFORE DELETE ON public.awards FOR EACH ROW EXECUTE FUNCTION public.tbd_awards_guard();