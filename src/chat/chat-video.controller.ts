import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";
import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ChatVideoQueues } from "./enums/ChatVideoQueues";
import { ExpireChatVideoDraft } from "./jobs/ExpireChatVideoDraft";

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

@Controller("matches/chat-video")
export class ChatVideoController {
  constructor(
    private readonly chat: ChatService,
    private readonly s3: S3Service,
    @InjectQueue(ChatVideoQueues.DraftExpiry)
    private readonly expiryQueue: Queue,
  ) {}

  @Post("sessions")
  public async create(
    @Req() request: Request,
    @Body() body: { type?: ChatLobbyType; roomId?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    if (!body.type || !body.roomId)
      throw new BadRequestException("room is required");
    const session = await this.chat.createVideoDraftSession(
      body.type,
      body.roomId,
      user,
    );
    if (!session)
      throw new ForbiddenException("you cannot send a video in this chat");
    await this.expiryQueue.add(
      ExpireChatVideoDraft.name,
      { sessionId: session.id },
      {
        jobId: session.id,
        delay: 5 * 60 * 1000 + 1000,
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      },
    );
    return session;
  }

  @Get("phone")
  public async phoneStatus(@Headers("authorization") authorization?: string) {
    const token = this.phoneToken(authorization);
    const session = await this.chat.getPhoneVideoDraft(token);
    if (!session)
      throw new NotFoundException(
        "This video session has expired or was already used.",
      );
    return session;
  }

  @Post("phone/upload")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_VIDEO_BYTES } }),
  )
  public async phoneUpload(
    @Headers("authorization") authorization: string | undefined,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { durationMs?: string },
  ) {
    if (!file) throw new BadRequestException("video is required");
    const token = this.phoneToken(authorization);
    const durationMs = Number(body.durationMs);
    const result = await this.chat.uploadPhoneVideoDraft(
      token,
      file.buffer,
      file.mimetype,
      durationMs,
    );
    if (!result)
      throw new BadRequestException(
        "video is invalid or this session is no longer available",
      );
    return { success: true };
  }

  @Post("phone/send")
  public async sendPhone(@Headers("authorization") authorization?: string) {
    const token = this.phoneToken(authorization);
    const result = await this.chat.sendPhoneVideoDraft(token);
    if (!result.accepted)
      throw new ForbiddenException(
        "Video could not be sent. Check that you still have permission to chat.",
      );
    return { success: true };
  }

  @Post("phone/retake")
  public async retakePhone(@Headers("authorization") authorization?: string) {
    const token = this.phoneToken(authorization);
    const result = await this.chat.retakePhoneVideoDraft(token);
    if (!result)
      throw new ConflictException("This video session is no longer available.");
    return result;
  }

  @Get("sessions/:id")
  public async status(@Param("id") id: string, @Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    const status = await this.chat.getOwnedVideoDraft(id, user);
    if (!status) throw new NotFoundException("video draft not found");
    return status;
  }

  @Post("sessions/:id/upload")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_VIDEO_BYTES } }),
  )
  public async directUpload(
    @Param("id") id: string,
    @Req() request: Request,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { durationMs?: string },
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    if (!file) throw new BadRequestException("video is required");
    const result = await this.chat.uploadOwnedVideoDraft(
      id,
      user,
      file.buffer,
      file.mimetype,
      Number(body.durationMs),
    );
    if (!result)
      throw new BadRequestException(
        "video is invalid or this session is no longer available",
      );
    return { success: true };
  }

  @Post("sessions/:id/send")
  public async sendOwned(
    @Param("id") id: string,
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    const result = await this.chat.sendOwnedVideoDraft(id, user);
    if (!result.accepted)
      throw new ForbiddenException(
        "Video could not be sent. Check that you still have permission to chat.",
      );
    return { success: true };
  }

  @Post("sessions/:id/retake")
  public async retakeOwned(
    @Param("id") id: string,
    @Req() request: Request,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    const result = await this.chat.retakeOwnedVideoDraft(id, user);
    if (!result)
      throw new ConflictException("This video session is no longer available.");
    return result;
  }

  @Post("phone/cancel")
  public async cancelPhone(@Headers("authorization") authorization?: string) {
    const token = this.phoneToken(authorization);
    await this.chat.cancelPhoneVideoDraft(token);
    return { success: true };
  }

  private phoneToken(authorization?: string): string {
    const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(authorization ?? "");
    if (!match) throw new NotFoundException("video session not found");
    return match[1];
  }

  @Post("sessions/:id/cancel")
  public async cancel(@Param("id") id: string, @Req() request: Request) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    await this.chat.cancelOwnedVideoDraft(id, user);
    return { success: true };
  }

  @Get("media/:id")
  public async getMedia(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = request.user as User | undefined;
    if (!user?.steam_id)
      throw new ForbiddenException("authentication required");
    const media = await this.chat.getVideoMediaForViewer(id, user);
    if (!media) throw new NotFoundException("video not found");
    const stat = await this.s3.stat(media.objectKey);
    const range = request.headers.range;
    response.setHeader("Content-Type", media.mimeType);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response
          .status(416)
          .setHeader("Content-Range", `bytes */${stat.size}`)
          .end();
        return;
      }
      const startValue = match[1] ? Number(match[1]) : undefined;
      const endValue = match[2] ? Number(match[2]) : undefined;
      if (startValue === undefined && endValue === undefined) {
        response
          .status(416)
          .setHeader("Content-Range", `bytes */${stat.size}`)
          .end();
        return;
      }
      const start =
        startValue === undefined
          ? Math.max(0, stat.size - endValue!)
          : startValue;
      const end = Math.min(
        startValue === undefined ? stat.size - 1 : (endValue ?? stat.size - 1),
        stat.size - 1,
      );
      if (
        (startValue === undefined && endValue === 0) ||
        start > end ||
        start >= stat.size
      ) {
        response
          .status(416)
          .setHeader("Content-Range", `bytes */${stat.size}`)
          .end();
        return;
      }
      response.status(206);
      response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      response.setHeader("Content-Length", String(end - start + 1));
      (await this.s3.getPartial(media.objectKey, start, end - start + 1)).pipe(
        response,
      );
      return;
    }
    response.setHeader("Content-Length", String(stat.size));
    (await this.s3.get(media.objectKey)).pipe(response);
  }
}
