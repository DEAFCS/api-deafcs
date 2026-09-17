DROP FUNCTION IF EXISTS public.recover_team_admin(uuid, bigint, text, json);

DROP TRIGGER IF EXISTS taiud_team_roster_admin_audit ON public.team_roster;
DROP FUNCTION IF EXISTS public.taiud_team_roster_admin_audit();

DROP TRIGGER IF EXISTS ct_team_roster_admin_guard ON public.team_roster;
DROP FUNCTION IF EXISTS public.ct_team_roster_admin_guard();

DROP TRIGGER IF EXISTS tbud_team_roster_admin_guard ON public.team_roster;
DROP FUNCTION IF EXISTS public.tbud_team_roster_admin_guard();

DROP TABLE IF EXISTS public.team_admin_audit;
