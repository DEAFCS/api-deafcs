CREATE OR REPLACE FUNCTION public.resolve_tournament_award(_tournament_id uuid, _placement int)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (SELECT ta.award_id
           FROM public.tournament_award_slots ta
          WHERE ta.tournament_id = _tournament_id
            AND ta.slot = CASE _placement WHEN 0 THEN 'mvp' WHEN 1 THEN 'champion' WHEN 2 THEN 'runner_up' WHEN 3 THEN 'third_place' END),
        (SELECT a.id
           FROM public.awards a
          WHERE a.system_key = CASE _placement
                WHEN 0 THEN 'tournament_mvp'
                WHEN 1 THEN 'tournament_gold'
                WHEN 2 THEN 'tournament_silver'
                WHEN 3 THEN 'tournament_bronze'
          END)
    );
$$;

CREATE OR REPLACE FUNCTION public.calculate_tournament_awards(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _awards_enabled boolean;
    _final_stage_id uuid;
    _winning_team_id uuid;
    _runner_up_team_id uuid;
    _third_team_id uuid;
    _award_third boolean := false;
    _mvp_steam_id bigint;
BEGIN
    SELECT awards_enabled INTO _awards_enabled
    FROM public.tournaments WHERE id = _tournament_id;

    -- Always clear prior auto rows so disabling / recalculating lands in a known state.
    -- Hand-granted awards survive; organizers own those explicitly.
    DELETE FROM public.award_recipients r
    USING public.award_occurrences o
    WHERE r.occurrence_id = o.id
      AND o.tournament_id = _tournament_id
      AND o.source = 'tournament_calculated';

    IF _awards_enabled IS DISTINCT FROM true THEN
        RETURN;
    END IF;

    -- Placement is decided by the LAST stage. Earlier stages are qualifiers;
    -- their standings don't reflect the tournament result (a team can go
    -- undefeated in Swiss yet lose the playoff final).
    SELECT id
      INTO _final_stage_id
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" DESC
    LIMIT 1;

    IF _final_stage_id IS NULL THEN
        RETURN;
    END IF;

    -- When the last stage played a third-place decider, the brackets order the
    -- medals directly: final winner/loser take gold/silver, the decider's
    -- winner takes bronze. The standings view cannot do this — the runner-up
    -- and the third-place winner both finish 1-1, so its wins-based
    -- tiebreakers (round ratio, team KDR, finally team id) pick silver and
    -- bronze arbitrarily.
    SELECT
        CASE WHEN fm.winning_lineup_id = fm.lineup_1_id
             THEN fb.tournament_team_id_1 ELSE fb.tournament_team_id_2 END,
        CASE WHEN fm.winning_lineup_id = fm.lineup_1_id
             THEN fb.tournament_team_id_2 ELSE fb.tournament_team_id_1 END,
        CASE WHEN tm.winning_lineup_id = tm.lineup_1_id
             THEN tb3.tournament_team_id_1 ELSE tb3.tournament_team_id_2 END
      INTO _winning_team_id, _runner_up_team_id, _third_team_id
    FROM public.tournament_stages ts
    JOIN public.tournament_brackets fb
      ON fb.tournament_stage_id = ts.id
    JOIN public.matches fm ON fm.id = fb.match_id
    JOIN public.tournament_brackets tb3
      ON tb3.tournament_stage_id = ts.id
     AND tb3.round = fb.round
     AND tb3.match_number = 2
     AND tb3.path = 'WB'
    JOIN public.matches tm ON tm.id = tb3.match_id
    WHERE ts.id = _final_stage_id
      AND ts.type = 'SingleElimination'
      AND ts.third_place_match = true
      AND fb.path = 'WB'
      AND fb.match_number = 1
      AND fb.round = (
          SELECT MAX(round) FROM public.tournament_brackets
          WHERE tournament_stage_id = _final_stage_id AND path = 'WB'
      )
      AND fm.winning_lineup_id IS NOT NULL
      AND tm.winning_lineup_id IS NOT NULL;

    -- Otherwise placement comes from v_team_stage_results, the single source
    -- of truth for tournament ordering (DE uses elimination round, RR/Swiss/SE
    -- use wins-based tiebreakers). The view's `placement` column shares ranks
    -- on ties, which lets us suppress the bronze when 3rd is contested
    -- (e.g. SingleElim with no third_place_match → both SF losers tied).
    -- Separate scalar selects keep this off `min(uuid)`, which Postgres lacks.
    IF _winning_team_id IS NULL THEN
        SELECT tournament_team_id INTO _winning_team_id
        FROM public.v_team_stage_results
        WHERE tournament_stage_id = _final_stage_id
          AND placement = 1
        ORDER BY tournament_team_id::text
        LIMIT 1;

        SELECT tournament_team_id INTO _runner_up_team_id
        FROM public.v_team_stage_results
        WHERE tournament_stage_id = _final_stage_id
          AND placement = 2
        ORDER BY tournament_team_id::text
        LIMIT 1;

        SELECT tournament_team_id INTO _third_team_id
        FROM public.v_team_stage_results
        WHERE tournament_stage_id = _final_stage_id
          AND placement = 3
          AND (
            SELECT COUNT(*) FROM public.v_team_stage_results
            WHERE tournament_stage_id = _final_stage_id AND placement = 3
          ) = 1
        LIMIT 1;
    END IF;

    _award_third := _third_team_id IS NOT NULL;

    -- Defensive guard for malformed brackets or stale data: a team cannot
    -- receive both a placement medal and bronze in the same calculation.
    IF _third_team_id IS NOT NULL
       AND (_third_team_id = _winning_team_id OR _third_team_id = _runner_up_team_id) THEN
        _third_team_id := NULL;
        _award_third := false;
    END IF;

    -- One deterministic occurrence per tournament achievement.
    CREATE TEMP TABLE IF NOT EXISTS _award_calc_occurrences(placement int PRIMARY KEY, occurrence_id uuid) ON COMMIT DROP;
    TRUNCATE _award_calc_occurrences;
    WITH upserted AS (
      INSERT INTO public.award_occurrences(award_id,tournament_id,placement,source,effective_at,calculation_key)
      SELECT public.resolve_tournament_award(_tournament_id,p.placement), _tournament_id,p.placement,
             'tournament_calculated',COALESCE(t.start,now()),
             'tournament:'||_tournament_id||':'||p.key
      FROM (VALUES (1,'champion'),(2,'runner-up'),(3,'third')) p(placement,key)
      CROSS JOIN public.tournaments t
      WHERE t.id=_tournament_id
        AND CASE p.placement WHEN 1 THEN _winning_team_id WHEN 2 THEN _runner_up_team_id ELSE _third_team_id END IS NOT NULL
      ON CONFLICT(calculation_key) DO UPDATE SET award_id=excluded.award_id,effective_at=excluded.effective_at,updated_at=now()
      RETURNING placement,id
    ) INSERT INTO _award_calc_occurrences SELECT placement,id FROM upserted;

    -- Team recipients plus only historical roster players who appeared in a completed official match for that entry.
    INSERT INTO public.award_recipients(occurrence_id,team_id,tournament_team_id)
    SELECT o.occurrence_id,tt.team_id,tt.id FROM _award_calc_occurrences o
    JOIN public.tournament_teams tt ON tt.id=CASE o.placement WHEN 1 THEN _winning_team_id WHEN 2 THEN _runner_up_team_id ELSE _third_team_id END
    WHERE tt.team_id IS NOT NULL ON CONFLICT DO NOTHING;

    INSERT INTO public.award_recipients(occurrence_id,player_steam_id,tournament_team_id)
    SELECT o.occurrence_id,r.player_steam_id,r.tournament_team_id
    FROM _award_calc_occurrences o
    JOIN public.tournament_team_roster r ON r.tournament_id=_tournament_id
      AND r.tournament_team_id=CASE o.placement WHEN 1 THEN _winning_team_id WHEN 2 THEN _runner_up_team_id ELSE _third_team_id END
    WHERE EXISTS (
      SELECT 1 FROM public.tournament_stages ts
      JOIN public.tournament_brackets b ON b.tournament_stage_id=ts.id
      JOIN public.matches m ON m.id=b.match_id AND m.winning_lineup_id IS NOT NULL
      JOIN public.match_lineup_players lp ON lp.steam_id=r.player_steam_id
       AND lp.match_lineup_id=CASE WHEN b.tournament_team_id_1=r.tournament_team_id THEN m.lineup_1_id ELSE m.lineup_2_id END
      WHERE ts.tournament_id=_tournament_id
        AND r.tournament_team_id IN (b.tournament_team_id_1,b.tournament_team_id_2)
    ) ON CONFLICT DO NOTHING;

    -- MVP is an individual occurrence chosen from players who actually appeared for the winning entry.
    IF _winning_team_id IS NOT NULL THEN
      SELECT pe.steam_id INTO _mvp_steam_id
      FROM public.player_elo pe
      JOIN public.tournament_brackets b ON b.match_id=pe.match_id
      JOIN public.tournament_stages ts ON ts.id=b.tournament_stage_id AND ts.tournament_id=_tournament_id
      JOIN public.matches m ON m.id=b.match_id AND m.winning_lineup_id IS NOT NULL
      JOIN public.tournament_team_roster r ON r.player_steam_id=pe.steam_id AND r.tournament_id=_tournament_id AND r.tournament_team_id=_winning_team_id
      JOIN public.match_lineup_players lp ON lp.steam_id=pe.steam_id
       AND lp.match_lineup_id=CASE WHEN b.tournament_team_id_1=_winning_team_id THEN m.lineup_1_id ELSE m.lineup_2_id END
      WHERE _winning_team_id IN (b.tournament_team_id_1,b.tournament_team_id_2)
      GROUP BY pe.steam_id ORDER BY AVG(COALESCE(pe.impact,1.0)) DESC,SUM(COALESCE(pe.impact,1.0)) DESC,pe.steam_id LIMIT 1;
      IF _mvp_steam_id IS NOT NULL THEN
        INSERT INTO public.award_occurrences(award_id,tournament_id,placement,source,effective_at,calculation_key)
        SELECT public.resolve_tournament_award(_tournament_id,0),_tournament_id,0,'tournament_calculated',COALESCE(start,now()),'tournament:'||_tournament_id||':mvp'
        FROM public.tournaments WHERE id=_tournament_id
        ON CONFLICT(calculation_key) DO UPDATE SET award_id=excluded.award_id,effective_at=excluded.effective_at,updated_at=now()
        RETURNING id INTO _final_stage_id;
        INSERT INTO public.award_recipients(occurrence_id,player_steam_id,tournament_team_id)
        VALUES(_final_stage_id,_mvp_steam_id,_winning_team_id) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
END;
$$;