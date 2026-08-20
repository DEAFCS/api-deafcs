DELETE FROM public.e_notification_types WHERE "value" IN (
    'VerificationApplicationPlayerReply',
    'VerificationApplicationAdminReply'
);
