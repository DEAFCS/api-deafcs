CREATE OR REPLACE FUNCTION public.tai_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM add_owner_to_team(NEW);
    UPDATE teams
    SET captain_steam_id = NEW.owner_steam_id
    WHERE id = NEW.id
      AND captain_steam_id IS NULL;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_teams ON public.teams;
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tai_teams();

CREATE OR REPLACE FUNCTION public.tbu_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.captain_steam_id IS NOT NULL
        AND NEW.captain_steam_id IS DISTINCT FROM OLD.captain_steam_id
        AND NOT EXISTS (
            SELECT 1
            FROM team_roster tr
            WHERE tr.team_id = NEW.id
              AND tr.player_steam_id = NEW.captain_steam_id
        ) THEN
        RAISE EXCEPTION 'Team captain must be a team member' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_teams ON public.teams;
CREATE TRIGGER tbu_teams BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tbu_teams();

-- tournament_teams.owner_steam_id is copied from the team when it registers
-- (tbi_tournament_team) and is read for tournament permissions and check-in
-- reminders. Follow a later ownership change so a former owner does not keep
-- manage rights on an entered team. Finished and cancelled tournaments keep
-- the owner of record. The tournament captain is a separate role and is not
-- touched.
CREATE OR REPLACE FUNCTION public.tau_teams_owner_sync() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.tournament_teams tt
       SET owner_steam_id = NEW.owner_steam_id
      FROM public.tournaments t
     WHERE tt.team_id = NEW.id
       AND t.id = tt.tournament_id
       AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams')
       AND tt.owner_steam_id IS DISTINCT FROM NEW.owner_steam_id;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_teams_owner_sync ON public.teams;
CREATE TRIGGER tau_teams_owner_sync
    AFTER UPDATE OF owner_steam_id ON public.teams
    FOR EACH ROW
    WHEN (NEW.owner_steam_id IS NOT NULL AND NEW.owner_steam_id IS DISTINCT FROM OLD.owner_steam_id)
    EXECUTE FUNCTION public.tau_teams_owner_sync();
