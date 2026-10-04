ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_twitch_channel_format;
ALTER TABLE public.players DROP COLUMN IF EXISTS twitch_channel;
