import { Controller } from "@nestjs/common";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "generated/schema";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";

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
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  // Fires on every INSERT into support_requests -- notifies every
  // administrator, same pattern as verification_applications above.
  @HasuraEvent()
  public async support_requests(data: HasuraEventData<any>) {
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
        role: "administrator",
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
        role: "administrator",
        entity_id: message.request_id,
      },
    );
  }
}
