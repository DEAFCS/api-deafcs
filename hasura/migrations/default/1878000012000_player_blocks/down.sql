DROP TRIGGER IF EXISTS guard_verification_application_cooldown ON public.verification_applications;
DROP FUNCTION IF EXISTS public.guard_verification_application_cooldown();

DROP TRIGGER IF EXISTS guard_team_roster_not_blocked ON public.team_roster;
DROP FUNCTION IF EXISTS public.guard_team_roster_not_blocked();

DROP TRIGGER IF EXISTS guard_lobby_players_not_blocked ON public.lobby_players;
DROP FUNCTION IF EXISTS public.guard_lobby_players_not_blocked();

DROP TRIGGER IF EXISTS guard_friends_not_blocked ON public.friends;
DROP FUNCTION IF EXISTS public.guard_friends_not_blocked();

DROP TRIGGER IF EXISTS td_v_my_blocks ON public.v_my_blocks;
DROP TRIGGER IF EXISTS ti_v_my_blocks ON public.v_my_blocks;
DROP FUNCTION IF EXISTS public.td_v_my_blocks();
DROP FUNCTION IF EXISTS public.ti_v_my_blocks();

DROP VIEW IF EXISTS public.v_my_blocks;

DROP TABLE IF EXISTS public.player_blocks;
