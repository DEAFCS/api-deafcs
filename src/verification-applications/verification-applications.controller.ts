import { Controller, BadRequestException } from "@nestjs/common";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../auth/types/User";
import { e_notification_types_enum } from "generated/schema";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";

// The role a player is bumped to once their verification application is
// approved. Matches the role matchmaking currently gates on (see
// public.matchmaking_min_role, ApplicationSettings.ts matchmakingAllowed).
const VERIFIED_ROLE = "verified_user";

type ApplicationRow = {
  id: string;
  player_steam_id: string;
  status: string;
};

// generated/schema predates these two tables (needs a live Hasura codegen
// run) -- raw SQL via PostgresService instead of the typed HasuraService
// query/mutation helpers, same workaround the awards feature uses
// (awards.service.ts) for the same bootstrapping problem.
@Controller("verification-applications")
export class VerificationApplicationsController {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  @HasuraAction()
  public async approveVerificationApplication(data: {
    application_id: string;
    user?: User;
  }) {
    const application = await this.requireApplication(data.application_id);

    await this.postgres.query(
      `UPDATE public.verification_applications
       SET status = 'approved', reviewed_by_steam_id = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [data.application_id, data.user?.steam_id ?? null],
    );

    await this.postgres.query(
      `UPDATE public.players SET role = $2 WHERE steam_id = $1`,
      [application.player_steam_id, VERIFIED_ROLE],
    );

    await this.notifications.notifyPlayers(
      "VerificationApplicationReviewed" as unknown as e_notification_types_enum,
      {
        title: "Verification Approved",
        message:
          "Your verification application was approved, you can now queue matchmaking.",
        role: "user",
        entity_id: data.application_id,
        steamIds: [application.player_steam_id],
      },
    );

    return { success: true };
  }

  @HasuraAction()
  public async rejectVerificationApplication(data: {
    application_id: string;
    reason?: string | null;
    user?: User;
  }) {
    const application = await this.requireApplication(data.application_id);

    await this.postgres.query(
      `UPDATE public.verification_applications
       SET status = 'rejected', reviewed_by_steam_id = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [data.application_id, data.user?.steam_id ?? null],
    );

    if (data.reason) {
      await this.postgres.query(
        `INSERT INTO public.verification_application_messages
           (application_id, sender_steam_id, is_admin, message)
         VALUES ($1, $2, true, $3)`,
        [data.application_id, data.user?.steam_id ?? null, data.reason],
      );
    }

    await this.notifications.notifyPlayers(
      "VerificationApplicationReviewed" as unknown as e_notification_types_enum,
      {
        title: "Verification Rejected",
        message: data.reason
          ? `Your verification application was rejected: ${NotificationsService.escapeHtml(data.reason)}`
          : "Your verification application was rejected.",
        role: "user",
        entity_id: data.application_id,
        steamIds: [application.player_steam_id],
      },
    );

    return { success: true };
  }

  // Fires on every INSERT into verification_applications -- notifies every
  // administrator, same pattern as requestNameChange (SystemController) and
  // notifyAdminsOfBan (NotificationsService).
  @HasuraEvent()
  public async verification_applications(data: HasuraEventData<any>) {
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
    const applicationUrl = `${this.appConfig.webDomain}/verification-applications/${data.new.id}`;

    await this.notifications.send(
      "VerificationApplicationSubmitted" as unknown as e_notification_types_enum,
      {
        title: "New Verification Application",
        message: `<a href="${applicationUrl}">${NotificationsService.escapeHtml(name)}</a> submitted a verification application.`,
        role: "administrator",
        entity_id: data.new.id,
      },
    );
  }

  // Fires on every INSERT into verification_application_messages -- notifies
  // whichever side did not send the message: an admin reply notifies the
  // applicant, a player reply notifies every administrator.
  @HasuraEvent()
  public async verification_application_messages(
    data: HasuraEventData<any>,
  ) {
    const message = data.new;

    const [application] = await this.postgres.query<
      Array<{ player_steam_id: string }>
    >(
      `SELECT player_steam_id FROM public.verification_applications WHERE id = $1`,
      [message.application_id],
    );

    if (!application) {
      return;
    }

    if (message.is_admin) {
      // Applicant-facing -- distinct from the player-reply type below so the
      // client can route a push-notification click straight to /verify
      // (this player's own status page) without needing to know their role.
      await this.notifications.notifyPlayers(
        "VerificationApplicationAdminReply" as unknown as e_notification_types_enum,
        {
          title: "Verification Application Reply",
          message: "An admin replied on your verification application.",
          role: "user",
          entity_id: message.application_id,
          steamIds: [application.player_steam_id],
        },
      );
      return;
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: application.player_steam_id },
        name: true,
      },
    });
    const name = player?.name ?? `Player ${application.player_steam_id}`;
    const applicationUrl = `${this.appConfig.webDomain}/verification-applications/${message.application_id}`;

    // Admin-facing -- see the comment above on the applicant-facing branch.
    await this.notifications.send(
      "VerificationApplicationPlayerReply" as unknown as e_notification_types_enum,
      {
        title: "Verification Application Reply",
        message: `<a href="${applicationUrl}">${NotificationsService.escapeHtml(name)}</a> replied on their verification application.`,
        role: "administrator",
        entity_id: message.application_id,
      },
    );
  }

  private async requireApplication(
    applicationId: string,
  ): Promise<ApplicationRow> {
    const [application] = await this.postgres.query<ApplicationRow[]>(
      `SELECT id, player_steam_id, status FROM public.verification_applications WHERE id = $1`,
      [applicationId],
    );

    if (!application) {
      throw new BadRequestException("Application not found");
    }

    return application;
  }
}
