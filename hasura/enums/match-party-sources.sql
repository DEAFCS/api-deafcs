insert into e_match_party_sources ("value", "description") values
    ('lobby', '5stack matchmaking lobby')
on conflict(value) do update set "description" = EXCLUDED."description"
