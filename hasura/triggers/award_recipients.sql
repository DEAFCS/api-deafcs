CREATE OR REPLACE FUNCTION public.tbu_award_recipients_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE award_source text;
BEGIN
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND NEW.revoked_at IS NOT NULL THEN
    SELECT source INTO award_source FROM public.award_occurrences WHERE id=OLD.occurrence_id;
    IF award_source <> 'manual' THEN RAISE EXCEPTION 'Calculated award recipients cannot be manually revoked'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tbu_award_recipients_guard ON public.award_recipients;
CREATE TRIGGER tbu_award_recipients_guard BEFORE UPDATE ON public.award_recipients FOR EACH ROW EXECUTE FUNCTION public.tbu_award_recipients_guard();