import {
  Controller,
  Post,
  Get,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import crypto from "crypto";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "generated/schema";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
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

// Bell/push notifications for the private support-request system (TricoN's
// feature, Hasura-only otherwise). Modelled directly on
// verification-applications.controller.ts -- same two-sided thread shape:
//   - a new request, or a player reply, notifies every administrator
//   - an admin reply notifies the player who opened the request
// The three e_notification_types values are added in
// 1878000001000_add_support_notification_types; generated/schema predates
// them so they're cast, same as the verification controller does.
@Controller("support-requests")
export class SupportRequestsController {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
    private readonly s3: S3Service,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // Uploaded ahead of the actual insert_support_requests_one /
  // insert_support_request_messages_one GraphQL mutation -- the request/
  // message id doesn't exist yet at upload time, so the object key is
  // scoped by the uploader's own steam_id instead and handed back for the
  // client to include as attachment_url on whichever row it inserts next.
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
    const user = this.requireUser(request);
    const ext = EXTENSION_BY_MIMETYPE[file.mimetype] || "bin";
    const hash = crypto.randomBytes(8).toString("hex");
    const path = `support-attachments/${user.steam_id}/${hash}.${ext}`;
    await this.s3.put(path, file.buffer, file.mimetype);
    return { success: true, path, contentType: file.mimetype };
  }

  // Streams the attachment back rather than exposing a public S3/bucket
  // URL, since a private player report's attachment is exactly as
  // sensitive as the report itself -- looks up whichever request or
  // message actually references this key and re-checks the same
  // ownership/staff rule the GraphQL select_permissions already enforce,
  // so knowing the key alone (visible to the owner/staff via the normal
  // query) never lets a third party fetch it.
  @Get("attachment")
  public async getAttachment(
    @Query("key") key: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    if (!key) {
      throw new BadRequestException("key is required");
    }

    const [row] = await this.postgres.query<
      Array<{
        content_type: string | null;
        removed: boolean;
        player_steam_id: string;
      }>
    >(
      `SELECT attachment_content_type AS content_type,
              attachment_removed_at IS NOT NULL AS removed,
              player_steam_id::text AS player_steam_id
         FROM public.support_requests
        WHERE attachment_url = $1
        UNION ALL
       SELECT m.attachment_content_type AS content_type,
              m.attachment_removed_at IS NOT NULL AS removed,
              r.player_steam_id::text AS player_steam_id
         FROM public.support_request_messages m
         JOIN public.support_requests r ON r.id = m.request_id
        WHERE m.attachment_url = $1
        LIMIT 1`,
      [key],
    );

    if (!row || row.removed) {
      throw new NotFoundException("attachment not found");
    }

    const isOwner = row.player_steam_id === String(user.steam_id);
    const isStaff = ["administrator", "moderator"].includes(user.role);
    if (!isOwner && !isStaff) {
      throw new ForbiddenException("you cannot view this attachment");
    }

    const stat = await this.s3.stat(key);
    response.setHeader(
      "Content-Type",
      row.content_type || "application/octet-stream",
    );
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");

    const range = request.headers.range;
    if (!range) {
      response.setHeader("Content-Length", String(stat.size));
      (await this.s3.get(key)).pipe(response);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    const startValue = match[1] ? Number(match[1]) : undefined;
    const endValue = match[2] ? Number(match[2]) : undefined;
    const start =
      startValue === undefined ? Math.max(0, stat.size - endValue!) : startValue;
    const end = Math.min(
      startValue === undefined ? stat.size - 1 : (endValue ?? stat.size - 1),
      stat.size - 1,
    );
    if (start > end || start >= stat.size) {
      response.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    response.status(206);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    response.setHeader("Content-Length", String(end - start + 1));
    (await this.s3.getPartial(key, start, end - start + 1)).pipe(response);
  }

  // Fires on every INSERT into support_requests -- notifies every
  // administrator (INSERT), and notifies the requester when their request
  // is closed (UPDATE status -> 'closed'). The event trigger is scoped to
  // insert + update-of-status only, so an updated_at bump from a new
  // message never reaches here.
  @HasuraEvent()
  public async support_requests(data: HasuraEventData<any>) {
    if (data.op === "UPDATE") {
      if (data.old?.status !== "closed" && data.new.status === "closed") {
        const subject = NotificationsService.escapeHtml(data.new.subject);
        await this.notifications.notifyPlayers(
          "SupportRequestClosed" as unknown as e_notification_types_enum,
          {
            title: "Support Request Closed",
            message: `Your support request was closed: ${subject}`,
            role: "user",
            entity_id: data.new.id,
            steamIds: [String(data.new.player_steam_id)],
          },
        );
      }
      return;
    }

    if (data.op !== "INSERT") {
      return;
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: data.new.player_steam_id },
        name: true,
      },
    });
    const name = player?.name ?? `Player ${data.new.player_steam_id}`;
    const requestUrl = `${this.appConfig.webDomain}/support/${data.new.id}`;
    const subject = NotificationsService.escapeHtml(data.new.subject);

    await this.notifications.send(
      "SupportRequestSubmitted" as unknown as e_notification_types_enum,
      {
        title: "New Support Request",
        message: `<a href="${requestUrl}">${NotificationsService.escapeHtml(name)}</a> opened a support request: ${subject}`,
        role: "moderator",
        entity_id: data.new.id,
      },
    );
  }

  // Fires on every INSERT into support_request_messages -- notifies
  // whichever side did not send the message: an admin reply notifies the
  // requester, a player reply notifies every administrator.
  @HasuraEvent()
  public async support_request_messages(data: HasuraEventData<any>) {
    const message = data.new;

    const [request] = await this.postgres.query<
      Array<{ player_steam_id: string; subject: string }>
    >(
      `SELECT player_steam_id::text AS player_steam_id, subject
         FROM public.support_requests WHERE id = $1`,
      [message.request_id],
    );

    if (!request) {
      return;
    }

    const subject = NotificationsService.escapeHtml(request.subject);

    if (message.is_admin) {
      // An admin reply only ever notifies the requester -- admins are
      // never pinged for an admin reply. Guard the one case that could
      // still self-notify: an admin replying on their own ticket.
      if (String(message.sender_steam_id) === request.player_steam_id) {
        return;
      }
      // Requester-facing -- distinct type from the player-reply one below
      // so a push-notification click can route without knowing the
      // clicking player's role.
      await this.notifications.notifyPlayers(
        "SupportRequestAdminReply" as unknown as e_notification_types_enum,
        {
          title: "Support Request Reply",
          message: `An admin replied on your support request: ${subject}`,
          role: "user",
          entity_id: message.request_id,
          steamIds: [request.player_steam_id],
        },
      );
      return;
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: request.player_steam_id },
        name: true,
      },
    });
    const name = player?.name ?? `Player ${request.player_steam_id}`;
    const requestUrl = `${this.appConfig.webDomain}/support/${message.request_id}`;

    // Admin-facing -- see the comment on the requester-facing branch.
    await this.notifications.send(
      "SupportRequestPlayerReply" as unknown as e_notification_types_enum,
      {
        title: "Support Request Reply",
        message: `<a href="${requestUrl}">${NotificationsService.escapeHtml(name)}</a> replied on their support request: ${subject}`,
        role: "moderator",
        entity_id: message.request_id,
      },
    );
  }
}
