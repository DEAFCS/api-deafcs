-- Intentionally non-destructive. Prior manual OFF choices cannot be inferred
-- from the resulting booleans. Do not mass-disable accounts or reset the retry
-- guard. Rolling application code back does not restore old consent choices.
-- Any future default/policy change requires its own reviewed forward migration.
SELECT 1;
