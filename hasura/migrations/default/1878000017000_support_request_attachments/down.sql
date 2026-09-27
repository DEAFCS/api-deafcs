ALTER TABLE public.support_requests
  DROP COLUMN IF EXISTS attachment_url,
  DROP COLUMN IF EXISTS attachment_content_type,
  DROP COLUMN IF EXISTS attachment_removed_at;

ALTER TABLE public.support_request_messages
  DROP COLUMN IF EXISTS attachment_url,
  DROP COLUMN IF EXISTS attachment_content_type,
  DROP COLUMN IF EXISTS attachment_removed_at;
