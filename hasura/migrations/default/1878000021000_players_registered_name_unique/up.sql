-- Registered player names are unique, ignoring case. Players who never
-- registered a name are outside the namespace (their name is just their
-- Steam name), so the index only covers name_registered rows.
CREATE UNIQUE INDEX IF NOT EXISTS players_registered_name_unique
  ON public.players (lower(name))
  WHERE name_registered IS TRUE;
