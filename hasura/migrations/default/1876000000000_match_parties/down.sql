ALTER TABLE public.match_lineup_players
    DROP COLUMN IF EXISTS party_id,
    DROP COLUMN IF EXISTS party_source;

DROP TABLE IF EXISTS public.e_match_party_sources;
