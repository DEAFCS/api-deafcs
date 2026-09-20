CREATE OR REPLACE FUNCTION public.tbau_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
changing_player_role text;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.role != OLD.role THEN
		SELECT current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role' INTO changing_player_role;

		-- Any request carrying Hasura session state is an end-user request.
		-- Platform role assignment is administrator-only; trusted internal SQL
		-- (which has no Hasura session) remains available for system workflows.
		IF changing_player_role IS NOT NULL
		   AND changing_player_role NOT IN ('admin', 'administrator') THEN
			RAISE EXCEPTION 'Only administrators can change player roles' USING ERRCODE = '22000';
		END IF;
	END IF;

	IF NEW.name_registered = true THEN
		IF EXISTS (
			SELECT 1 FROM players 
			WHERE name = NEW.name 
			AND steam_id != NEW.steam_id
			AND name_registered = true
		) THEN
			RAISE EXCEPTION 'Name is already registered by another player' USING ERRCODE = '22000';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbau_players ON public.players;
CREATE TRIGGER tbau_players BEFORE INSERT OR UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION public.tbau_players();
