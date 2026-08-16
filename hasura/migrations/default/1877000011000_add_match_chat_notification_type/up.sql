INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('MatchChatMessage', 'New message in a match''s chat')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
