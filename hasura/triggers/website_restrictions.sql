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

-- Attaching (or re-verifying) enforce_website_restriction_write across every
-- table below requires an AccessExclusiveLock per table for the DROP+CREATE
-- TRIGGER pair, which can deadlock against long-lived Hasura subscriptions
-- reading these same tables (e.g. the open-matchmaking lobby browser holding
-- an AccessShareLock on `lobbies`). This file is re-applied on every
-- hasura.setup() run whenever its digest changes (see HasuraService.apply()),
-- including immediately after the versioned migration that first installs
-- these same triggers -- so unconditionally redoing the DROP+CREATE here
-- doubles the live-lock exposure for no reason once the trigger is already
-- correctly in place. Instead, only take the lock on a table whose trigger
-- is actually missing or actually different from the intended definition.
DO $$
DECLARE
  _table_name text;
  _fn_oid oid := to_regprocedure('public.enforce_website_restriction_write()');
  -- pg_trigger.tgtype bitmask for "FOR EACH ROW BEFORE INSERT OR UPDATE OR
  -- DELETE": TRIGGER_TYPE_ROW(1) | TRIGGER_TYPE_BEFORE(2) |
  -- TRIGGER_TYPE_INSERT(4) | TRIGGER_TYPE_DELETE(8) | TRIGGER_TYPE_UPDATE(16).
  -- This is Postgres's own stable, documented catalog encoding for a
  -- trigger's timing/events, not a value specific to this database.
  _want_tgtype constant smallint := 31;
  _existing_tgtype smallint;
  _existing_tgfoid oid;
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
      -- Do not assume the trigger name alone proves its definition is
      -- correct: compare the actual timing/events (tgtype) and the actual
      -- target function (tgfoid) of whatever is currently installed, not
      -- just whether a same-named trigger exists.
      SELECT t.tgtype, t.tgfoid
        INTO _existing_tgtype, _existing_tgfoid
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = _table_name
         AND t.tgname = 'enforce_website_restriction_write';

      IF _existing_tgtype IS DISTINCT FROM _want_tgtype
         OR _existing_tgfoid IS DISTINCT FROM _fn_oid THEN
        EXECUTE format(
          'DROP TRIGGER IF EXISTS enforce_website_restriction_write ON public.%I',
          _table_name
        );
        EXECUTE format(
          'CREATE TRIGGER enforce_website_restriction_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_website_restriction_write()',
          _table_name
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;
