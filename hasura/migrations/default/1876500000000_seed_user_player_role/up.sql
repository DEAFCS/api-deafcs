-- Fresh (never-before-migrated) databases apply hasura/migrations before
-- hasura/enums (HasuraService.setup() runs applyMigrations() then apply()
-- on enums/functions/views/triggers, in that order). Migration
-- 1877000000000_seed_system_player inserts a players row with role =
-- 'user', but e_player_roles.'user' isn't seeded until hasura/enums/
-- player-roles.sql runs afterward, so that insert fails its FK on a fresh
-- install. Production already has 'user' seeded from every prior boot's
-- enum application, so it's unaffected; this only fixes the fresh-install
-- ordering gap. Seed just the one role value 1877000000000 needs, ahead of
-- it, without touching that migration or the enums pipeline.
INSERT INTO public.e_player_roles (value, description)
VALUES ('user', 'Basic User')
ON CONFLICT (value) DO NOTHING;
