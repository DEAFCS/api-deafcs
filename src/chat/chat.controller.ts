import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import crypto from "crypto";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { ChatService } from "./chat.service";
import { lobbies_set_input } from "generated/schema";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";

const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPE =
  /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/;
const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

@Controller("chat")
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly s3: S3Service,
  ) {}

  @HasuraEvent()
  public async chat_lobbies_removed(data: HasuraEventData<lobbies_set_input>) {
    await this.chatService.removeLobby(ChatLobbyType.MatchMaking, data.old.id);
  }

  // Uploaded ahead of the actual "lobby:chat" websocket send -- the chat
  // message doesn't exist yet at upload time, so this just stashes the
  // file in S3 under the uploader's own steam_id and hands back the key
  // for the client to include as `attachment` on the socket send. Mirrors
  // support-requests.controller.ts's attachment endpoint exactly.
  @Post("attachment")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadAttachment(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_ATTACHMENT_BYTES }),
          new FileTypeValidator({ fileType: ALLOWED_ATTACHMENT_TYPE }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    const ext = EXTENSION_BY_MIMETYPE[file.mimetype] || "bin";
    const hash = crypto.randomBytes(8).toString("hex");
    const path = `chat-attachments/${user.steam_id}/${hash}.${ext}`;
    await this.s3.put(path, file.buffer, file.mimetype);
    return { success: true, path, contentType: file.mimetype };
  }

  // Streams a sent attachment back by its random id (never the raw S3 key,
  // see ChatService.sendMessageToChat) -- re-checks the viewer still has
  // access to the lobby the attachment was sent in, same rules as reading
  // the chat itself.
  @Get("attachment/:id")
  public async getAttachment(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!id) {
      throw new BadRequestException("id is required");
    }

    const attachment = await this.chatService.getChatAttachmentForViewer(
      id,
      user,
    );
    if (!attachment) {
      throw new NotFoundException("attachment not found");
    }

    const stat = await this.s3.stat(attachment.objectKey);
    response.setHeader("Content-Type", attachment.contentType);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");

    const range = request.headers.range;
    if (!range) {
      response.setHeader("Content-Length", String(stat.size));
      (await this.s3.get(attachment.objectKey)).pipe(response);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response
        .status(416)
        .setHeader("Content-Range", `bytes */${stat.size}`)
        .end();
      return;
    }
    const startValue = match[1] ? Number(match[1]) : undefined;
    const endValue = match[2] ? Number(match[2]) : undefined;
    const start =
      startValue === undefined
        ? Math.max(0, stat.size - endValue!)
        : startValue;
    const end = Math.min(
      startValue === undefined ? stat.size - 1 : (endValue ?? stat.size - 1),
      stat.size - 1,
    );
    if (start > end || start >= stat.size) {
      response
        .status(416)
        .setHeader("Content-Range", `bytes */${stat.size}`)
        .end();
      return;
    }
    response.status(206);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    response.setHeader("Content-Length", String(end - start + 1));
    (
      await this.s3.getPartial(attachment.objectKey, start, end - start + 1)
    ).pipe(response);
  }
}
