DROP FUNCTION IF EXISTS public.calculate_tournament_trophies(uuid);

CREATE OR REPLACE FUNCTION public.calculate_tournament_trophies(_tournament_id uuid)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.calculate_tournament_awards(_tournament_id); END $$;
