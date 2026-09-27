-- Per-player allowlist for the (currently hidden from most players)
-- self-service API Keys settings page -- replaces the old blanket
-- "any role above X" gate in ApiKeys.createApiKey with an explicit,
-- admin-granted flag per player. Defaults to false: nobody gets API
-- access until an admin turns it on for them individually.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS api_key_enabled boolean NOT NULL DEFAULT false;
