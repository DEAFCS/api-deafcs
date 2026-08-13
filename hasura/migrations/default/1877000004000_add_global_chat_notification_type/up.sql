INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('GlobalChatMessage', 'New message in Global Chat')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
