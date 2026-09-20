-- Tournament creation is fail-closed at Tournament Organizer. Preserve an
-- explicit Administrator-only choice, but repair missing, invalid, or lower
-- legacy values so they cannot grant creation to ordinary roles.
INSERT INTO public.settings (name, value)
VALUES ('public.create_tournaments_role', 'tournament_organizer')
ON CONFLICT (name) DO UPDATE
SET value = EXCLUDED.value
WHERE public.settings.value IS NULL
   OR public.settings.value NOT IN ('tournament_organizer', 'administrator');
