-- Join token for the admin <-> applicant webcam call on a verification
-- application (see VerificationCallService). Mirrors
-- lobby_camera_tokens exactly: minted on demand when either side
-- chooses to join (from "this device" or the phone/QR path), since an
-- anonymous phone scanning a QR code has no deafcs.net session of its
-- own. Unlike the lobby call this is always exactly two parties (the
-- admin who rang, and the applicant), so there is no participants list
-- -- just one token per (application, steam_id).
CREATE TABLE "public"."verification_call_tokens" (
    "token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "application_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("token"),
    UNIQUE ("application_id", "steam_id"),
    FOREIGN KEY ("application_id") REFERENCES "public"."verification_applications" ("id")
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY ("steam_id") REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE CASCADE
);
