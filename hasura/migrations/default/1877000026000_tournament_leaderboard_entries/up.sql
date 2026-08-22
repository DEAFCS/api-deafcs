-- Zero-row "type-definition" table used purely as the SETOF return type for
-- get_tournament_leaderboard() (see hasura/functions/tournaments/). Same
-- pattern as leaderboard_entries (1771545600000_leaderboard_functions),
-- kept as its own table rather than reusing leaderboard_entries because that
-- type is shared by three existing producers (get_leaderboard,
-- get_event_leaderboard, get_league_season_leaderboard) and matches
-- RETURN QUERY SELECT by column POSITION -- adding tournament-specific
-- columns (team identity, rating, adr) to the shared type would force every
-- other producer to be edited in lockstep. A dedicated type avoids that
-- coupling entirely.
CREATE TABLE IF NOT EXISTS public.tournament_leaderboard_entries (
  player_steam_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_avatar_url TEXT,
  player_custom_avatar_url TEXT,
  player_country TEXT,
  tournament_team_id UUID,
  team_id UUID,
  team_name TEXT,
  rating FLOAT NOT NULL DEFAULT 0,
  adr FLOAT NOT NULL DEFAULT 0,
  kills INT NOT NULL DEFAULT 0,
  deaths INT NOT NULL DEFAULT 0,
  assists INT NOT NULL DEFAULT 0,
  kdr FLOAT NOT NULL DEFAULT 0,
  headshot_percentage FLOAT NOT NULL DEFAULT 0,
  rounds_played INT NOT NULL DEFAULT 0,
  matches_played INT NOT NULL DEFAULT 0
);
