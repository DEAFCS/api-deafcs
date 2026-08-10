-- NOT a safe standalone live rollback. Dropping this column while any
-- function still SELECTs it (or while Hasura metadata still exposes it)
-- breaks that call immediately with "structure of query does not match
-- function result type" / a GraphQL field-not-found error, the same way
-- omitting the column from a function's SELECT would break it going
-- forward. A real rollback is a coordinated maintenance-window operation:
-- revert the web deploy, revert the Hasura metadata change, revert
-- hasura/functions/leaderboard/get_leaderboard.sql +
-- hasura/functions/events/get_event_leaderboard.sql +
-- hasura/functions/leaderboard/get_league_season_leaderboard.sql to stop
-- selecting player_custom_avatar_url, deploy the API with those reverted
-- function files, confirm it booted healthy, and only then run this down
-- migration. Never run this in isolation against a live system that still
-- has any of those pieces active.
ALTER TABLE public.leaderboard_entries
  DROP COLUMN IF EXISTS player_custom_avatar_url;
