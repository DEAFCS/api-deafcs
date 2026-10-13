-- Disabling the feature does not discard conversation or block/history data.
ALTER TABLE public.players ALTER COLUMN allow_message_requests SET DEFAULT false;
UPDATE public.players SET allow_message_requests = false;
