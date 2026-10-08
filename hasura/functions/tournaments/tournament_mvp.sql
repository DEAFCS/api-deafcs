-- Manual tournament MVP (a deliberate DEAFCS difference from upstream 5Stack,
-- which picks the MVP automatically). The tournament MVP is chosen by hand by
-- the tournament's organizers after it has finished; nothing here ranks,
-- recommends or weights players.
--
-- Stored in the awards model: one `manual` award_occurrences row per choice
-- (placement 0, who chose and when, an optional note) with one recipient that
-- names the player and the tournament team they actually played for. Changing
-- or clearing the MVP soft-revokes the previous recipient (who, when, why), so
-- every choice stays on record and exactly one MVP is active. Nothing here
-- depends on tournament roster membership, and calculate_tournament_awards
-- never touches these rows.

-- Players who actually took part in a tournament match: recorded activity in
-- it, not just a seat in the lineup. The team is the tournament team they
-- played for in their most recent match, read from the bracket, not from the
-- roster. Stats are guidance only and come from the same aggregation the
-- tournament Stats tab uses. Sorted by name, never by rating.
CREATE OR REPLACE FUNCTION public.tournament_mvp_candidates(_tournament_id uuid)
RETURNS TABLE (
    player_steam_id text,
    player_name text,
    tournament_team_id uuid,
    team_name text,
    matches_played integer,
    rating double precision,
    kills integer,
    deaths integer,
    assists integer
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH played AS (
        SELECT mlp.steam_id,
               m.id AS match_id,
               m.created_at,
               CASE WHEN mlp.match_lineup_id = m.lineup_1_id
                    THEN tb.tournament_team_id_1
                    ELSE tb.tournament_team_id_2
               END AS tt_id
          FROM public.tournament_brackets tb
          INNER JOIN public.tournament_stages ts
                  ON ts.id = tb.tournament_stage_id
                 AND ts.tournament_id = _tournament_id
          INNER JOIN public.matches m ON m.id = tb.match_id
          INNER JOIN public.match_lineup_players mlp
                  ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
         WHERE tb.match_id IS NOT NULL
           AND mlp.steam_id IS NOT NULL
           AND public.player_has_match_activity(m.id, mlp.steam_id)
    ),
    per_player AS (
        SELECT p.steam_id,
               COUNT(DISTINCT p.match_id)::integer AS matches_played,
               (ARRAY_AGG(p.tt_id ORDER BY p.created_at DESC))[1] AS tt_id
          FROM played p
         GROUP BY p.steam_id
    )
    SELECT pp.steam_id::text,
           pl.name::text,
           pp.tt_id,
           COALESCE(t.name, tt.name)::text,
           pp.matches_played,
           COALESCE(lb.rating, 0)::double precision,
           COALESCE(lb.kills, 0)::integer,
           COALESCE(lb.deaths, 0)::integer,
           COALESCE(lb.assists, 0)::integer
      FROM per_player pp
      INNER JOIN public.players pl ON pl.steam_id = pp.steam_id
      LEFT JOIN public.tournament_teams tt ON tt.id = pp.tt_id
      LEFT JOIN public.teams t ON t.id = tt.team_id
      LEFT JOIN public.get_tournament_leaderboard(_tournament_id) lb
             ON lb.player_steam_id = pp.steam_id::text
     ORDER BY lower(pl.name), pp.steam_id;
END;
$$;

-- Chooses (or changes) the tournament MVP. Authorization is the caller's job
-- (the API allows the tournament's organizers and site administrators); this
-- enforces the rules of the award itself.
CREATE OR REPLACE FUNCTION public.set_tournament_mvp(
    _tournament_id uuid,
    _player_steam_id bigint,
    _actor_steam_id bigint,
    _note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament public.tournaments;
    _award_id uuid;
    _tournament_team_id uuid;
    _occurrence_id uuid;
    _recipient_id uuid;
    _current_player bigint;
BEGIN
    -- Serializes concurrent choices for the same tournament.
    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = _tournament_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Tournament not found';
    END IF;

    IF _tournament.status <> 'Finished' THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The tournament MVP can only be chosen once the tournament has finished';
    END IF;

    IF public.tournament_min_players_per_lineup(_tournament) <> 5 THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'The tournament MVP is only awarded in 5v5 tournaments';
    END IF;

    IF _tournament.awards_enabled IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Awards are not enabled for this tournament';
    END IF;

    SELECT c.tournament_team_id INTO _tournament_team_id
      FROM public.tournament_mvp_candidates(_tournament_id) c
     WHERE c.player_steam_id = _player_steam_id::text;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This player did not play in this tournament';
    END IF;

    _award_id := public.resolve_tournament_award(_tournament_id, 0);
    IF _award_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'No tournament MVP award is configured';
    END IF;

    -- Choosing the player who already holds it changes nothing.
    SELECT r.player_steam_id, r.id INTO _current_player, _recipient_id
      FROM public.award_recipients r
      INNER JOIN public.award_occurrences o ON o.id = r.occurrence_id
     WHERE o.tournament_id = _tournament_id
       AND o.placement = 0
       AND r.revoked_at IS NULL
     LIMIT 1;

    IF _recipient_id IS NOT NULL AND _current_player IS NOT DISTINCT FROM _player_steam_id THEN
        RETURN _recipient_id;
    END IF;

    UPDATE public.award_recipients r
       SET revoked_at = now(),
           revoked_by = _actor_steam_id,
           revocation_reason = 'MVP changed'
                               || COALESCE(': ' || NULLIF(btrim(_note), ''), '')
      FROM public.award_occurrences o
     WHERE o.id = r.occurrence_id
       AND o.tournament_id = _tournament_id
       AND o.placement = 0
       AND r.revoked_at IS NULL;

    INSERT INTO public.award_occurrences
        (award_id, tournament_id, placement, source, effective_at, note, awarded_by)
    VALUES
        (_award_id, _tournament_id, 0, 'manual', now(), NULLIF(btrim(_note), ''), _actor_steam_id)
    RETURNING id INTO _occurrence_id;

    INSERT INTO public.award_recipients
        (occurrence_id, player_steam_id, tournament_team_id, recipient_note)
    VALUES
        (_occurrence_id, _player_steam_id, _tournament_team_id, NULLIF(btrim(_note), ''))
    RETURNING id INTO _recipient_id;

    RETURN _recipient_id;
END;
$$;

-- Clears the tournament MVP. The choice stays on record, revoked with who,
-- when and why.
CREATE OR REPLACE FUNCTION public.clear_tournament_mvp(
    _tournament_id uuid,
    _actor_steam_id bigint,
    _note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _cleared integer;
BEGIN
    PERFORM 1 FROM public.tournaments t WHERE t.id = _tournament_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Tournament not found';
    END IF;

    UPDATE public.award_recipients r
       SET revoked_at = now(),
           revoked_by = _actor_steam_id,
           revocation_reason = 'MVP cleared'
                               || COALESCE(': ' || NULLIF(btrim(_note), ''), '')
      FROM public.award_occurrences o
     WHERE o.id = r.occurrence_id
       AND o.tournament_id = _tournament_id
       AND o.placement = 0
       AND r.revoked_at IS NULL;

    GET DIAGNOSTICS _cleared = ROW_COUNT;

    IF _cleared = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament has no MVP to clear';
    END IF;
END;
$$;
