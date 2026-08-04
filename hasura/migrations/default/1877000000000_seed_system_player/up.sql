-- Reserved sentinel player row used as sanctioned_by_steam_id for bans issued
-- automatically by the system (leaver/no-show escalation), rather than by an
-- admin. steam_id 0 can never collide with a real Steam64 id.
INSERT INTO public.players (steam_id, name, role) VALUES
    (0, 'DEAFCS System', 'user')
ON CONFLICT (steam_id) DO NOTHING;
