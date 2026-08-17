INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('OrganizerChatMessage', 'New message in Organizer Chat')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
