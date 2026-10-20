-- DEAFCS-only: an on-demand server freed by a match that ended or was deleted
-- while that match's pod can still be running on its node and ports (GOTV
-- delay, demo upload, graceful stop). tau_matches / tbd_matches set it; the
-- API clears it once Kubernetes confirms the pod is gone
-- (MatchAssistantService.reconcileDrainingOnDemandServers). Until then the
-- server is not handed to another match. draining_check_at is when the API
-- starts checking, never when the server becomes free.
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS draining_match_id uuid;
ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS draining_check_at timestamptz;
