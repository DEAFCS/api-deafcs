DROP TABLE IF EXISTS "public"."push_notification_preferences";

DELETE FROM public.e_notification_types
WHERE "value" IN ('ChatMessage', 'TournamentCreated', 'TournamentReminder');
