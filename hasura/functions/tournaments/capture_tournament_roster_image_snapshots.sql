CREATE OR REPLACE FUNCTION public.resolve_tournament_roster_image_snapshot(
    _tournament_team_id uuid,
    _player_steam_id bigint
) RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    AS $$
DECLARE
    _team_id uuid;
    _team_roster_image text;
    _player_roster_image text;
BEGIN
    SELECT tt.team_id
      INTO _team_id
      FROM public.tournament_teams tt
     WHERE tt.id = _tournament_team_id;

    -- Lock the source rows while the snapshot is being resolved. Avatar
    -- replacement/removal takes the matching FOR UPDATE lock, preventing a
    -- source object from being deleted between capture and persistence.
    SELECT p.roster_image_url
      INTO _player_roster_image
      FROM public.players p
     WHERE p.steam_id = _player_steam_id
     FOR SHARE;

    IF _team_id IS NOT NULL THEN
        SELECT tr.roster_image_url
          INTO _team_roster_image
          FROM public.team_roster tr
         WHERE tr.team_id = _team_id
           AND tr.player_steam_id = _player_steam_id
         FOR SHARE;
    END IF;

    RETURN COALESCE(_team_roster_image, _player_roster_image);
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_tournament_roster_image_snapshots(
    _tournament_id uuid
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    _roster RECORD;
BEGIN
    FOR _roster IN
        SELECT ttr.tournament_team_id, ttr.player_steam_id
          FROM public.tournament_team_roster ttr
         WHERE ttr.tournament_id = _tournament_id
           AND ttr.roster_image_url_snapshot IS NULL
         ORDER BY ttr.tournament_team_id, ttr.player_steam_id
         FOR UPDATE
    LOOP
        UPDATE public.tournament_team_roster ttr
           SET roster_image_url_snapshot =
               public.resolve_tournament_roster_image_snapshot(
                   _roster.tournament_team_id,
                   _roster.player_steam_id
               )
         WHERE ttr.tournament_id = _tournament_id
           AND ttr.tournament_team_id = _roster.tournament_team_id
           AND ttr.player_steam_id = _roster.player_steam_id
           AND ttr.roster_image_url_snapshot IS NULL;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_tournament_roster_image_snapshots(
    _tournament_id uuid
) RETURNS void
    LANGUAGE sql
    AS $$
    UPDATE public.tournament_team_roster
       SET roster_image_url_snapshot = NULL
     WHERE tournament_id = _tournament_id;
$$;
