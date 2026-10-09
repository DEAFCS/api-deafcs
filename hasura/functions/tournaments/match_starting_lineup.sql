-- Starting lineup of a tournament match (a deliberate DEAFCS difference from
-- upstream 5Stack, which seats the whole tournament roster in every match and
-- tells the starters from the substitutes only by who shows up and plays).
--
-- A tournament roster may hold starters AND substitutes. A match is played by
-- exactly the starting size (2 in Wingman, 5 in Competitive). The match
-- lineup (match_lineup_players) IS the list of active players for that match:
-- it is seeded with a default pick, the team's staff can swap it until the
-- match starts, and it is never rewritten afterwards. Substitutes stay on the
-- tournament roster only, so they are not seated, not rated and carry no stats
-- for a match they did not start in.

-- The tournament team that plays a match lineup, read from the bracket.
CREATE OR REPLACE FUNCTION public.tournament_match_lineup_team(_match_lineup_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT CASE WHEN m.lineup_1_id = ml.id THEN tb.tournament_team_id_1
                ELSE tb.tournament_team_id_2
           END
      FROM public.match_lineups ml
      INNER JOIN public.matches m ON m.id = ml.match_id
      INNER JOIN public.tournament_brackets tb ON tb.match_id = m.id
     WHERE ml.id = _match_lineup_id
     LIMIT 1;
$$;

-- A team with substitutes has to CONFIRM its starting lineup before the match
-- lineup can be ready or check in. The generated default is only a starting
-- point: without a confirmation a free win or a no-show (no play recorded at
-- all) could not tell who was meant to play. A team whose tournament roster is
-- exactly the starting size has nothing to choose and never needs one.
-- Derived from the roster, so a team that later gains a substitute is asked
-- too, and persisted only as the confirmation itself
-- (match_lineups.starting_lineup_confirmed_at).
CREATE OR REPLACE FUNCTION public.match_lineup_needs_starting_lineup_confirmation(
    match_lineup public.match_lineups
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _tournament_team_id uuid;
    _size integer;
BEGIN
    IF match_lineup.starting_lineup_confirmed_at IS NOT NULL THEN
        RETURN false;
    END IF;

    _tournament_team_id := public.tournament_match_lineup_team(match_lineup.id);

    IF _tournament_team_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT public.match_min_players_per_lineup(m) INTO _size
      FROM public.matches m WHERE m.id = match_lineup.match_id;

    RETURN (
        SELECT count(*) FROM public.tournament_team_roster ttr
         WHERE ttr.tournament_team_id = _tournament_team_id
    ) > COALESCE(_size, 0);
END;
$$;

-- Keeps exactly one match captain among the seated players. The tournament
-- captain is the match captain when seated. A captain who sits a match out
-- stays the tournament captain (and keeps managing the lineup, which is
-- checked against the tournament team, not the seat); the match captain, the
-- seat that checks in and picks in the veto, is then the seated tournament
-- roster Admin with the lowest steam id, or, with no Admin seated, the seated
-- player with the lowest steam id. Deterministic, never dependent on who
-- happened to hold the flag before.
CREATE OR REPLACE FUNCTION public.tournament_set_lineup_captain(
    _match_lineup_id uuid,
    _tournament_captain bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _pick bigint;
BEGIN
    IF _tournament_captain IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.match_lineup_players mlp
         WHERE mlp.match_lineup_id = _match_lineup_id AND mlp.steam_id = _tournament_captain
    ) THEN
        _pick := _tournament_captain;
    ELSE
        SELECT mlp.steam_id INTO _pick
          FROM public.match_lineup_players mlp
          LEFT JOIN public.tournament_team_roster ttr
                 ON ttr.tournament_team_id = public.tournament_match_lineup_team(_match_lineup_id)
                AND ttr.player_steam_id = mlp.steam_id
         WHERE mlp.match_lineup_id = _match_lineup_id
         ORDER BY CASE WHEN ttr.role = 'Admin' THEN 0 ELSE 1 END,
                  mlp.steam_id
         LIMIT 1;
    END IF;

    UPDATE public.match_lineup_players
       SET captain = (steam_id = _pick)
     WHERE match_lineup_id = _match_lineup_id
       AND captain IS DISTINCT FROM (steam_id = _pick);
END;
$$;

-- Who may choose a team's starting lineup: the tournament captain, the
-- tournament team's owner or Admin, the owning team's owner, captain or Admin,
-- and the tournament's organizers and site administrators (all of which
-- can_manage_tournament_team already covers, except the tournament captain).
-- An ordinary Member may not.
CREATE OR REPLACE FUNCTION public.can_set_match_starting_lineup(
    _tournament_team_id uuid,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _team public.tournament_teams;
    _user_steam_id bigint;
BEGIN
    SELECT tt.* INTO _team FROM public.tournament_teams tt WHERE tt.id = _tournament_team_id;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF public.can_manage_tournament_team(_team, hasura_session) THEN
        RETURN true;
    END IF;

    _user_steam_id := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;

    RETURN _user_steam_id IS NOT NULL AND _team.captain_steam_id = _user_steam_id;
END;
$$;

-- Default starting lineup for a tournament team: the captain first, then the
-- players already seated (so a roster change never discards a choice), then
-- the owning team's Starter / Substitute / Benched order, then steam id. This
-- is only ever a default; staff can change it until the match starts.
CREATE OR REPLACE FUNCTION public.tournament_default_starters(
    _tournament_team_id uuid,
    _match_lineup_id uuid,
    _size integer
) RETURNS bigint[]
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(array_agg(x.player_steam_id ORDER BY x.ord), ARRAY[]::bigint[])
      FROM (
        SELECT ttr.player_steam_id,
               row_number() OVER (
                   ORDER BY
                       CASE WHEN ttr.player_steam_id = tt.captain_steam_id THEN 0 ELSE 1 END,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM public.match_lineup_players mlp
                            WHERE mlp.match_lineup_id = _match_lineup_id
                              AND mlp.steam_id = ttr.player_steam_id
                       ) THEN 0 ELSE 1 END,
                       CASE tr.status
                           WHEN 'Starter' THEN 1
                           WHEN 'Substitute' THEN 2
                           WHEN 'Benched' THEN 3
                           ELSE 4
                       END,
                       ttr.player_steam_id
               ) AS ord
          FROM public.tournament_team_roster ttr
          INNER JOIN public.tournament_teams tt ON tt.id = ttr.tournament_team_id
          LEFT JOIN public.team_roster tr
                 ON tr.team_id = tt.team_id
                AND tr.player_steam_id = ttr.player_steam_id
         WHERE ttr.tournament_team_id = _tournament_team_id
           AND NOT public.is_admin_sanctioned(
               (SELECT p FROM public.players p WHERE p.steam_id = ttr.player_steam_id)
           )
      ) x
     WHERE x.ord <= _size;
$$;

-- Chooses the active players of a tournament match lineup. Exactly the
-- starting size, all on the tournament roster. Saving it IS the confirmation
-- (starting_lineup_confirmed_at), also when the default is kept as it is. The
-- tournament captain may sit the match out and still manage the lineup. Only
-- while the match has not started: a Live or finished match keeps its lineup
-- exactly as played. A seat that changes hands loses its check-in, so the new
-- player confirms for themselves.
CREATE OR REPLACE FUNCTION public.set_match_starting_lineup(
    _match_id uuid,
    _match_lineup_id uuid,
    _steam_ids bigint[],
    hasura_session json
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _match public.matches;
    _tournament_team_id uuid;
    _team public.tournament_teams;
    _size integer;
    _distinct bigint[];
    _bad bigint;
    _captain bigint;
    _old_extra_ids uuid[];
    _new_extra_steam_ids bigint[];
    _pair_count integer;
    i integer;
BEGIN
    SELECT m.* INTO _match FROM public.matches m WHERE m.id = _match_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Match not found';
    END IF;

    IF _match_lineup_id IS DISTINCT FROM _match.lineup_1_id
       AND _match_lineup_id IS DISTINCT FROM _match.lineup_2_id THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'That lineup is not part of this match';
    END IF;

    _tournament_team_id := public.tournament_match_lineup_team(_match_lineup_id);

    IF _tournament_team_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Only a tournament match has a starting lineup to choose';
    END IF;

    IF NOT public.can_set_match_starting_lineup(_tournament_team_id, hasura_session) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'You cannot choose the starting lineup for this team';
    END IF;

    IF _match.status NOT IN ('Scheduled', 'WaitingForCheckIn') THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The starting lineup is locked once the match has started';
    END IF;

    -- A team that has checked in plays with the lineup it checked in with: the
    -- team's own staff cannot change it any more. Tournament organizers and
    -- site administrators keep that as the recovery path.
    IF public.is_match_lineup_ready(
           (SELECT ml FROM public.match_lineups ml WHERE ml.id = _match_lineup_id)
       )
       AND NOT public.is_tournament_organizer(
           (SELECT t FROM public.tournaments t
              INNER JOIN public.tournament_stages ts ON ts.tournament_id = t.id
              INNER JOIN public.tournament_brackets tb ON tb.tournament_stage_id = ts.id
             WHERE tb.match_id = _match_id
             LIMIT 1),
           hasura_session
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The lineup is locked once the team has checked in';
    END IF;

    _size := public.match_min_players_per_lineup(_match);

    SELECT COALESCE(array_agg(DISTINCT s), ARRAY[]::bigint[]) INTO _distinct
      FROM unnest(COALESCE(_steam_ids, ARRAY[]::bigint[])) AS s;

    IF COALESCE(array_length(_steam_ids, 1), 0) <> COALESCE(array_length(_distinct, 1), 0)
       OR COALESCE(array_length(_distinct, 1), 0) <> _size THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = format('Select exactly %s players for the starting lineup', _size);
    END IF;

    SELECT s INTO _bad
      FROM unnest(_distinct) AS s
     WHERE NOT EXISTS (
         SELECT 1 FROM public.tournament_team_roster ttr
          WHERE ttr.tournament_team_id = _tournament_team_id
            AND ttr.player_steam_id = s
     )
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Only players on the tournament roster can be in the starting lineup';
    END IF;

    SELECT s INTO _bad
      FROM unnest(_distinct) AS s
     WHERE public.is_admin_sanctioned((SELECT p FROM public.players p WHERE p.steam_id = s))
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'A sanctioned player cannot be in the starting lineup';
    END IF;

    SELECT tt.* INTO _team FROM public.tournament_teams tt WHERE tt.id = _tournament_team_id;
    _captain := _team.captain_steam_id;

    -- Re-seat by changing row content, not row count, so the lineup size
    -- guards never trip (see refresh_tournament_match_lineup_teams).
    SELECT COALESCE(array_agg(mlp.id ORDER BY mlp.steam_id), ARRAY[]::uuid[]) INTO _old_extra_ids
      FROM public.match_lineup_players mlp
     WHERE mlp.match_lineup_id = _match_lineup_id
       AND mlp.steam_id <> ALL(_distinct);

    SELECT COALESCE(array_agg(s ORDER BY s), ARRAY[]::bigint[]) INTO _new_extra_steam_ids
      FROM unnest(_distinct) AS s
     WHERE s NOT IN (
         SELECT mlp.steam_id FROM public.match_lineup_players mlp
          WHERE mlp.match_lineup_id = _match_lineup_id
     );

    _pair_count := LEAST(
        COALESCE(array_length(_old_extra_ids, 1), 0),
        COALESCE(array_length(_new_extra_steam_ids, 1), 0)
    );

    IF _pair_count > 0 THEN
        FOR i IN 1.._pair_count LOOP
            UPDATE public.match_lineup_players
               SET steam_id = _new_extra_steam_ids[i],
                   checked_in = false
             WHERE id = _old_extra_ids[i];
        END LOOP;
    END IF;

    IF COALESCE(array_length(_new_extra_steam_ids, 1), 0) > _pair_count THEN
        FOR i IN (_pair_count + 1)..array_length(_new_extra_steam_ids, 1) LOOP
            INSERT INTO public.match_lineup_players (match_lineup_id, steam_id)
            VALUES (_match_lineup_id, _new_extra_steam_ids[i]);
        END LOOP;
    END IF;

    IF COALESCE(array_length(_old_extra_ids, 1), 0) > _pair_count THEN
        FOR i IN (_pair_count + 1)..array_length(_old_extra_ids, 1) LOOP
            DELETE FROM public.match_lineup_players WHERE id = _old_extra_ids[i];
        END LOOP;
    END IF;

    PERFORM public.tournament_set_lineup_captain(_match_lineup_id, _captain);

    UPDATE public.match_lineups
       SET starting_lineup_confirmed_at = now()
     WHERE id = _match_lineup_id;
END;
$$;
