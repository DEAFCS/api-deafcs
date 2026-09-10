-- Direction-specific types (mirrors the verification-application split in
-- 1877000023000) so a push-notification click can route to the right
-- place without knowing the clicking player's role: admin-facing types
-- open the thread from the admin queue, the requester-facing one opens
-- the requester's own view of the same thread. Both currently resolve to
-- /support/{id} on the client, but keeping them distinct leaves that
-- routing free to diverge later.
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('SupportRequestSubmitted', 'A player opened a support request (admin-facing)'),
    ('SupportRequestPlayerReply', 'A player replied on their support request (admin-facing)'),
    ('SupportRequestAdminReply', 'An admin replied on a support request (requester-facing)')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
