INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('VerificationApplicationSubmitted', 'A player submitted a verification application'),
    ('VerificationApplicationReplied', 'A reply was posted on a verification application'),
    ('VerificationApplicationReviewed', 'A verification application was approved or rejected')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
