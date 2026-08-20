DELETE FROM public.e_notification_types WHERE "value" IN (
    'VerificationApplicationSubmitted',
    'VerificationApplicationReplied',
    'VerificationApplicationReviewed'
);
