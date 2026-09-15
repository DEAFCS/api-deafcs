-- A draft game shouldn't affect ELO unless the host opts in.
ALTER TABLE draft_games ALTER COLUMN elo_enabled SET DEFAULT false;
