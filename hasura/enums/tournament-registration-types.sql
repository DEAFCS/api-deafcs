-- Adapted from 5Stack API c23d08084075e620387cebeabb2fa62e2b78f828.
-- MIT Copyright (c) 2025 5Stack.gg; see LICENSE. DEAFCS adaptations below.
insert into e_tournament_registration_types ("value", "description") values
    ('teams', 'Only pre-formed teams may register'),
    ('free_agents', 'Only individual players may register; teams are drafted from the pool'),
    ('both', 'Pre-formed teams and individual free agents may both register')
on conflict(value) do update set "description" = EXCLUDED."description"
