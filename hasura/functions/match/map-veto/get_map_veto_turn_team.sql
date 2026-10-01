-- Which team (1 or 2) acts on the given 0-based map veto turn, counting
-- only Ban, Pick and Decider actions (a Side choice is never a turn: it goes
-- to the team that did not make the preceding Pick).
--
-- The one place the turn order lives: get_map_veto_picking_lineup_id (who
-- acts now) and get_map_veto_sequence (the whole veto, for display) both
-- use it, so the two can never disagree.
CREATE OR REPLACE FUNCTION public.get_map_veto_turn_team(best_of int, turn_index int)
RETURNS int
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        -- best of 3 swaps teams after the 4th pick
        WHEN best_of = 3 AND turn_index >= 4 THEN
            CASE WHEN turn_index % 2 = 0 THEN 2 ELSE 1 END
        ELSE
            CASE WHEN turn_index % 2 = 0 THEN 1 ELSE 2 END
    END
$$;
