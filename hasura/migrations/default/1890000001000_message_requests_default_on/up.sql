-- Explicitly approved one-time transition, including existing manual OFF choices.
-- schema_migrations is the runner's authoritative applied-version ledger. The
-- default is a second guard for direct SQL retries before that version is saved.
-- Lock before reading either guard so concurrent retries cannot repeat the update.
DO $$
DECLARE previous_default text; changed integer := 0;
BEGIN
 LOCK TABLE public.players IN ACCESS EXCLUSIVE MODE;
 SELECT column_default INTO previous_default FROM information_schema.columns
 WHERE table_schema='public' AND table_name='players' AND column_name='allow_message_requests';
 IF previous_default IS NULL OR previous_default NOT IN ('false','true') THEN
  RAISE EXCEPTION 'Unexpected Message Requests default; review before transition';
 END IF;
 IF previous_default='false' AND NOT EXISTS (
  SELECT 1 FROM hdb_catalog.schema_migrations WHERE version=1890000001000
 ) THEN
  UPDATE public.players SET allow_message_requests=true WHERE allow_message_requests=false;
  GET DIAGNOSTICS changed = ROW_COUNT;
 END IF;
 ALTER TABLE public.players ALTER COLUMN allow_message_requests SET DEFAULT true;
 RAISE NOTICE 'Message Requests default ON: % existing accounts enabled', changed;
END; $$;
