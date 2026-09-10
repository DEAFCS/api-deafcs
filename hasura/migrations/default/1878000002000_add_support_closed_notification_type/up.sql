INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('SupportRequestClosed', 'A support request was closed (requester-facing)')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
