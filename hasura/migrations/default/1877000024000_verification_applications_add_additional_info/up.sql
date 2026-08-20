ALTER TABLE "public"."verification_applications"
    ADD COLUMN IF NOT EXISTS "additional_info" text;
