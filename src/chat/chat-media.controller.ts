import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { SteamGuard } from "src/auth/strategies/SteamGuard";
import { ThrottlerBehindProxyGuard } from "src/auth/strategies/ThrottlerBehindProxyGuard";
import { User } from "src/auth/types/User";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";

// Ported from 5stackgg/api cecc882 src/chat/chat-media.controller.ts (the
// upload routes only; DEAFCS serves sent attachments from
// ChatController's GET chat/attachment/:id, and has no posters or GIF search
// here).
//
// Uploads go through the api in parts rather than to storage directly: each
// part is a request well under Cloudflare's 100 MB cap, and nothing needs the
// bucket to answer a browser's CORS preflight.
@Controller("chat")
export class ChatMediaController {
  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static readonly STATUS: Partial<Record<ChatErrorCode, HttpStatus>> = {
    [ChatErrorCode.NotAllowed]: HttpStatus.FORBIDDEN,
    [ChatErrorCode.Gagged]: HttpStatus.FORBIDDEN,
    [ChatErrorCode.NotFound]: HttpStatus.NOT_FOUND,
    [ChatErrorCode.Disabled]: HttpStatus.NOT_FOUND,
    [ChatErrorCode.TooLarge]: HttpStatus.PAYLOAD_TOO_LARGE,
    [ChatErrorCode.UnsupportedType]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    [ChatErrorCode.TooManyPending]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.QuotaExceeded]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.RateLimited]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.Unavailable]: HttpStatus.BAD_GATEWAY,
    [ChatErrorCode.Busy]: HttpStatus.SERVICE_UNAVAILABLE,
  };

  constructor(private readonly attachments: ChatAttachmentsService) {}

  private static fail(code: ChatErrorCode): never {
    throw new HttpException(
      { code },
      ChatMediaController.STATUS[code] ?? HttpStatus.BAD_REQUEST,
    );
  }

  private static attachmentId(id: string): string {
    if (!ChatMediaController.UUID.test(id)) {
      ChatMediaController.fail(ChatErrorCode.NotFound);
    }

    return id;
  }

  // Anything but a raw body is read by one of the app's body parsers first,
  // and the stream handed on would already have ended. The length is what the
  // body is held to, so a request that does not give one is refused.
  private static rawLength(request: Request, max: number): number {
    if (!request.is("application/octet-stream")) {
      throw new HttpException(
        { code: ChatErrorCode.UnsupportedType },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }

    const declared = Number(request.headers["content-length"]);

    if (!Number.isSafeInteger(declared) || declared <= 0) {
      throw new HttpException(
        { code: ChatErrorCode.Invalid },
        HttpStatus.LENGTH_REQUIRED,
      );
    }

    if (declared > max) {
      ChatMediaController.fail(ChatErrorCode.TooLarge);
    }

    return declared;
  }

  @Post("attachments")
  @UseGuards(SteamGuard, ThrottlerBehindProxyGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  public async create(
    @Req() request: Request,
    @Body()
    body: {
      name?: unknown;
      size?: unknown;
      mime_type?: unknown;
    },
  ) {
    const user = request.user as User;

    const created = await this.attachments.create(
      String(user.steam_id),
      body ?? {},
    );

    if ("code" in created) {
      ChatMediaController.fail(created.code);
    }

    return created;
  }

  @Put("attachments/:id/parts/:part")
  @UseGuards(SteamGuard)
  public async part(
    @Req() request: Request,
    @Param("id") id: string,
    @Param("part") part: string,
  ) {
    const attachmentId = ChatMediaController.attachmentId(id);

    const length = ChatMediaController.rawLength(
      request,
      ChatAttachmentsService.PART_SIZE,
    );

    const refusal = await this.attachments.uploadPart(
      String((request.user as User).steam_id),
      attachmentId,
      Number(part),
      request,
      length,
    );

    if (refusal) {
      ChatMediaController.fail(refusal);
    }

    return { success: true };
  }

  @Post("attachments/:id/complete")
  @UseGuards(SteamGuard)
  public async complete(@Req() request: Request, @Param("id") id: string) {
    const completed = await this.attachments.complete(
      String((request.user as User).steam_id),
      ChatMediaController.attachmentId(id),
    );

    if ("code" in completed) {
      ChatMediaController.fail(completed.code);
    }

    return completed;
  }

  @Delete("attachments/:id")
  @UseGuards(SteamGuard)
  public async discard(@Req() request: Request, @Param("id") id: string) {
    await this.attachments.discard(
      String((request.user as User).steam_id),
      ChatMediaController.attachmentId(id),
    );

    return { success: true };
  }
}
