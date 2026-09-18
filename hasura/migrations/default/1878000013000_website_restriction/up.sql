INSERT INTO public.e_sanction_types (value, description)
VALUES ('website_restriction', 'Account is restricted to read-only website access')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION public.is_website_restricted(_steam_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.player_sanctions ps
     WHERE ps.player_steam_id = _steam_id
       AND ps.type = 'website_restriction'
       AND ps.deleted_at IS NULL
       AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
  );
$$;

CREATE OR REPLACE FUNCTION public.guard_active_website_restriction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type <> 'website_restriction'
     OR NEW.deleted_at IS NOT NULL
     OR (NEW.remove_sanction_date IS NOT NULL AND NEW.remove_sanction_date <= now()) THEN
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.reason), '') IS NULL THEN
    RAISE EXCEPTION 'a reason is required for a website restriction';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('website_restriction:' || NEW.player_steam_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM public.player_sanctions existing
     WHERE existing.player_steam_id = NEW.player_steam_id
       AND existing.type = 'website_restriction'
       AND existing.deleted_at IS NULL
       AND (existing.remove_sanction_date IS NULL OR existing.remove_sanction_date > now())
       AND existing.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'player already has an active website restriction';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_active_website_restriction ON public.player_sanctions;
CREATE TRIGGER guard_active_website_restriction
BEFORE INSERT OR UPDATE OF type, reason, remove_sanction_date, deleted_at
ON public.player_sanctions
FOR EACH ROW
EXECUTE FUNCTION public.guard_active_website_restriction();

CREATE OR REPLACE FUNCTION public.enforce_website_restriction_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  _session_text text;
  _actor_text text;
BEGIN
  _session_text := current_setting('hasura.user', true);
  IF NULLIF(_session_text, '') IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  _actor_text := NULLIF(_session_text::jsonb ->> 'x-hasura-user-id', '');
  IF _actor_text IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.is_website_restricted(_actor_text::bigint) THEN
    RAISE EXCEPTION 'Your DEAFCS account is restricted to read-only access.'
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

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
      EXECUTE format(
        'CREATE TRIGGER enforce_website_restriction_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_website_restriction_write()',
        _table_name
      );
    END IF;
  END LOOP;
END;
$$;
