ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_registered_name_length;
ALTER TABLE public.players ADD CONSTRAINT players_registered_name_length CHECK (name_registered IS NOT TRUE OR char_length(name) BETWEEN 3 AND 15);
