import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import crypto from "crypto";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { ChatService } from "./chat.service";
import { lobbies_set_input } from "generated/schema";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";
import { GiphyService } from "../giphy/giphy.service";

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
    private readonly giphy: GiphyService,
  ) {}

  @HasuraEvent()
  public async chat_lobbies_removed(data: HasuraEventData<lobbies_set_input>) {
    await this.chatService.removeLobby(ChatLobbyType.MatchMaking, data.old.id);
  }

  // Proxies GIPHY's search so the API key never reaches the browser (it
  // would otherwise be trivial to lift from a network request and burn
  // through the free Beta key's 100 requests/hour limit). An empty `q`
  // returns trending GIFs, matching the picker's default view before the
  // user types anything.
  @Get("gif-search")
  public async searchGifs(
    @Req() request: Request,
    @Query("q") query: string | undefined,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    return { results: await this.giphy.search(query ?? "") };
  }

  // Uploaded ahead of the actual "lobby:chat" websocket send -- the chat
  // message doesn't exist yet at upload time, so this just stashes the
  // file in S3 under the uploader's own steam_id and hands back the key
  // for the client to include as `attachment` on the socket send.
  //
  // Takes the file as a raw binary body (Content-Type: the file's own
  // mimetype) rather than multipart/form-data like support-requests'
  // equivalent endpoint does -- confirmed in production that a ~95MB
  // video from an iPhone never even reached this server when sent as
  // multipart: Safari appears to buffer the whole multipart body in
  // memory before sending anything, which silently failed for a file
  // that size. A raw body lets the browser stream the file directly.
  // See chat.module.ts for the express.raw() body parser this route
  // needs instead of the global json/urlencoded ones.
  @Post("attachment")
  public async uploadAttachment(@Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }

    const contentType = (request.headers["content-type"] || "").split(";")[0].trim();
    if (!ALLOWED_ATTACHMENT_TYPE.test(contentType)) {
      throw new BadRequestException(
        "unsupported file type, expected an image or video",
      );
    }

    const buffer = request.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new BadRequestException("file is required");
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("file is too large");
    }

    const ext = EXTENSION_BY_MIMETYPE[contentType] || "bin";
    const hash = crypto.randomBytes(8).toString("hex");
    const path = `chat-attachments/${user.steam_id}/${hash}.${ext}`;
    await this.s3.put(path, buffer, contentType);
    return { success: true, path, contentType };
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
