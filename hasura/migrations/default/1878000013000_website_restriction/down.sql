DO $$
DECLARE
  _table_name text;
BEGIN
  FOREACH _table_name IN ARRAY ARRAY[
    'friends',
    'lobbies', 'lobby_players',
    'draft_games', 'draft_game_players', 'draft_game_picks',
    'matches', 'match_invites', 'match_lineups', 'match_lineup_players',
    'match_maps', 'match_options', 'match_map_veto_picks',
    'match_region_veto_picks', 'match_veto_picks', 'match_streams',
    'match_clips', 'clip_render_jobs',
    'teams', 'team_roster', 'team_invites',
    'team_scrim_requests', 'team_scrim_request_proposals',
    'team_scrim_alerts', 'team_scrim_availability', 'team_scrim_settings',
    'tournaments', 'tournament_brackets', 'tournament_categories',
    'tournament_individual_signups', 'tournament_organizers',
    'tournament_organizer_teams', 'tournament_prizes', 'tournament_roster',
    'tournament_stages', 'tournament_stage_windows', 'tournament_teams',
    'tournament_team_invites', 'tournament_team_roster',
    'tournament_trophies', 'tournament_trophy_configs',
    'support_requests', 'support_request_messages',
    'verification_applications', 'verification_application_known_players',
    'verification_application_messages',
    'events', 'event_media', 'event_media_players', 'event_organizers',
    'event_players', 'event_teams', 'event_tournaments',
    'league_scheduling_proposals', 'league_teams',
    'league_team_rosters', 'league_team_seasons',
    'seasons', 'player_sanctions'
  ] LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = _table_name
         AND c.relkind IN ('r', 'p')
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS enforce_website_restriction_write ON public.%I',
        _table_name
      );
    END IF;
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.enforce_website_restriction_write();
DROP TRIGGER IF EXISTS guard_active_website_restriction ON public.player_sanctions;
DROP FUNCTION IF EXISTS public.guard_active_website_restriction();
DROP FUNCTION IF EXISTS public.is_website_restricted(bigint);

DELETE FROM public.player_sanctions WHERE type = 'website_restriction';
DELETE FROM public.e_sanction_types WHERE value = 'website_restriction';
