CREATE OR REPLACE FUNCTION public.recover_team_admin(
    _team_id uuid,
    _player_steam_id bigint,
    _reason text,
    hasura_session json
)
RETURNS SETOF public.team_roster
LANGUAGE plpgsql
AS $$
BEGIN
    IF hasura_session ->> 'x-hasura-role' IS DISTINCT FROM 'administrator' THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'Site administrator access is required to recover a team Admin.';
    END IF;

    IF NULLIF(btrim(_reason), '') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'A recovery reason is required.';
    END IF;

    PERFORM 1
    FROM public.teams
    WHERE id = _team_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Team not found.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.team_roster
        WHERE team_id = _team_id
          AND role = 'Admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This team already has an Admin.';
    END IF;

    PERFORM 1
    FROM public.team_roster
    WHERE team_id = _team_id
      AND player_steam_id = _player_steam_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Recovery target must be an existing team member.';
    END IF;

    PERFORM set_config('fivestack.team_admin_audit_action', 'staff_recovery', true);
    PERFORM set_config('fivestack.team_admin_audit_reason', btrim(_reason), true);

    UPDATE public.team_roster
    SET role = 'Admin'
    WHERE team_id = _team_id
      AND player_steam_id = _player_steam_id;

    PERFORM set_config('fivestack.team_admin_audit_action', '', true);
    PERFORM set_config('fivestack.team_admin_audit_reason', '', true);

    RETURN QUERY
    SELECT *
    FROM public.team_roster
    WHERE team_id = _team_id
      AND player_steam_id = _player_steam_id;
END;
$$;
