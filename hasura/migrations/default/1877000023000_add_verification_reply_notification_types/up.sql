-- Split VerificationApplicationReplied into two direction-specific types so
-- the client can route a push-notification click to the right destination
-- (admin -> /verification-applications/{id}, applicant -> /verify) without
-- needing to know the clicking player's role, which isn't available inside
-- the service worker. VerificationApplicationReplied itself is left in
-- place (unused going forward) rather than removed, to avoid orphaning any
-- already-sent notification rows that still reference it.
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('VerificationApplicationPlayerReply', 'A player replied on their verification application (admin-facing)'),
    ('VerificationApplicationAdminReply', 'An admin replied on a verification application (applicant-facing)')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
