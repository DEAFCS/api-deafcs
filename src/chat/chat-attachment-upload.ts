import { MiddlewareConsumer, RequestMethod } from "@nestjs/common";
import { NextFunction, Request, Response, raw } from "express";

export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPE =
  /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/;

// The raw parser below holds the whole body in memory before the controller
// runs, so a request the controller would refuse anyway (signed out, a type
// it does not take, a declared size over the limit) is refused before any of
// it is read. Same answers as ChatController.uploadAttachment.
export function attachmentUploadGate(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!(request.user as { steam_id?: string } | undefined)?.steam_id) {
    response.status(403).json({ message: "authentication required" });
    return;
  }

  const contentType = (request.headers["content-type"] || "")
    .split(";")[0]
    .trim();
  if (!ALLOWED_ATTACHMENT_TYPE.test(contentType)) {
    response
      .status(400)
      .json({ message: "unsupported file type, expected an image or video" });
    return;
  }

  if (Number(request.headers["content-length"]) > MAX_ATTACHMENT_BYTES) {
    response.status(413).json({ message: "file is too large" });
    return;
  }

  next();
}

// The attachment upload route takes the file as a raw binary body (see
// ChatController.uploadAttachment) rather than JSON or multipart/form-data,
// so it needs its own body parser instead of the app-wide json/urlencoded
// ones from main.ts -- those only apply to their own content types and
// leave this route's stream untouched. `type: () => true` matches
// regardless of the client's Content-Type (already checked by the gate and
// re-validated in the controller itself).
export function configureAttachmentUpload(consumer: MiddlewareConsumer) {
  consumer
    .apply(attachmentUploadGate, raw({ type: () => true, limit: "210mb" }))
    .forRoutes({ path: "chat/attachment", method: RequestMethod.POST });
}
