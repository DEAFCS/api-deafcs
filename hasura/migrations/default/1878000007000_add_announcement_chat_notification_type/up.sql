-- Role-broadcast type for the new Announcements chat channel (mirrors
-- GlobalChatMessage/OrganizerChatMessage -- see ChatService.notifyLobbyMembers,
-- which routes it through sendSilent with role: verified_user, no fixed
-- roster). Requires a Hasura metadata reload after this migration runs
-- (raw SQL insert into an enum table doesn't refresh the live GraphQL
-- enum on its own).
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('AnnouncementChatMessage', 'An admin posted a new announcement')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
