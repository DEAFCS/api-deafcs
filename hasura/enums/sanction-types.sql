insert into e_sanction_types ("value", "description") values
    ('ban', 'Player is not able to participate in any activity'),
    ('mute', 'Player cannot use voice chat in game'),
    ('gag', 'Player cannot use text chat in game'),
    ('silence', 'Player muted and gagged'),
    ('website_chat_mute', 'Player cannot send messages in website chat')
on conflict(value) do update set "description" = EXCLUDED."description"
