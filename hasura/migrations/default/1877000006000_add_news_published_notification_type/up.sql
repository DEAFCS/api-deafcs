INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('NewsPublished', 'A news article was published')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
