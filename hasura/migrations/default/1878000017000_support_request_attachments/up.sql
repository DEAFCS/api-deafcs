-- One optional image/video attachment per support request and per
-- reply message (not multiple -- the request only ever asked for a
-- single file "beside the message box"). attachment_url stores the S3
-- object key, never a public URL -- it's only ever served through an
-- auth-checked NestJS endpoint (see SupportRequestsController), since
-- these reports can be private player reports. attachment_removed_at
-- is set by the hourly retention job once the file is deleted after 7
-- days, so the thread can keep showing "attachment removed" instead of
-- silently losing the reference.
ALTER TABLE public.support_requests
  ADD COLUMN IF NOT EXISTS attachment_url text NULL,
  ADD COLUMN IF NOT EXISTS attachment_content_type text NULL,
  ADD COLUMN IF NOT EXISTS attachment_removed_at timestamptz NULL;

ALTER TABLE public.support_request_messages
  ADD COLUMN IF NOT EXISTS attachment_url text NULL,
  ADD COLUMN IF NOT EXISTS attachment_content_type text NULL,
  ADD COLUMN IF NOT EXISTS attachment_removed_at timestamptz NULL;
