-- Adapted from 5Stack API c23d08084075e620387cebeabb2fa62e2b78f828.
-- MIT Copyright (c) 2025 5Stack.gg; see LICENSE. DEAFCS adaptations below.
insert into e_tournament_free_agent_statuses ("value", "description") values
    ('registered', 'Signed up and waiting for the draft'),
    ('drafted', 'Placed on a drafted team'),
    ('waitlisted', 'Did not make the cut; first in line if a slot opens'),
    ('withdrawn', 'Left the free agent pool')
on conflict(value) do update set "description" = EXCLUDED."description"
