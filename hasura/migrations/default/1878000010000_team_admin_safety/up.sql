CREATE TABLE public.team_admin_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    previous_role text,
    new_role text,
    action text NOT NULL,
    reason text,
    actor_steam_id bigint,
    actor_role text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT team_admin_audit_admin_transition_check
        CHECK (previous_role = 'Admin' OR new_role = 'Admin')
);

CREATE INDEX team_admin_audit_team_created_idx
    ON public.team_admin_audit (team_id, created_at DESC);

COMMENT ON TABLE public.team_admin_audit IS
    'Immutable audit trail for granting, revoking, removing, and recovering team Admin access.';
