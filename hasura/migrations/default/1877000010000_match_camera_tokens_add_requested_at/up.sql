-- Marks a manually-triggered "spot check" camera request (the
-- doping-control-style admin action: "show your camera right now",
-- independent of the tournament's camera_required setting). Null
-- means this row was minted by the normal camera_required flow, not
-- an admin request.
ALTER TABLE "public"."match_camera_tokens"
  ADD COLUMN "requested_at" timestamp with time zone;
