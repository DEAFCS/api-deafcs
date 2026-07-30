CREATE OR REPLACE FUNCTION public.clear_tournament_calculated_awards(_tournament_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.award_recipients r USING public.award_occurrences o
  WHERE r.occurrence_id=o.id AND o.tournament_id=_tournament_id AND o.source='tournament_calculated';
  DELETE FROM public.award_occurrences WHERE tournament_id=_tournament_id AND source='tournament_calculated';
END $$;

CREATE OR REPLACE FUNCTION public.recalculate_tournament_awards(_tournament_id uuid)
RETURNS SETOF public.award_occurrences LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.calculate_tournament_awards(_tournament_id);
  RETURN QUERY SELECT * FROM public.award_occurrences WHERE tournament_id=_tournament_id AND source='tournament_calculated';
END $$;