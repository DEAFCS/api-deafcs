SET check_function_bodies = false;
INSERT INTO public.e_award_sources (value, description) VALUES
  ('manual', 'Granted by hand'),
  ('tournament_calculated', 'Calculated from a tournament result'),
  ('elo_season_calculated', 'Reserved for matchmaking ELO season calculation'),
  ('league_calculated', 'Reserved for league calculation'),
  ('migration', 'Converted from legacy trophy history')
ON CONFLICT (value) DO UPDATE SET description=EXCLUDED.description;