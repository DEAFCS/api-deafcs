-- Player-owned Twitch channel, stored as the normalized channel login
-- (never a URL or embed code). Set through the API (PUT /twitch/me), which
-- normalizes "TricoN", "twitch.tv/tricon" and "https://www.twitch.tv/tricon/"
-- to "tricon"; the constraint keeps anything else out of the column.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS twitch_channel text NULL;
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_twitch_channel_format;
ALTER TABLE public.players ADD CONSTRAINT players_twitch_channel_format
  CHECK (twitch_channel IS NULL OR twitch_channel ~ '^[a-z0-9_]{4,25}$');
