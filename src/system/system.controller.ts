import { Controller, Post, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { SystemService } from "./system.service";
import { HasuraAction } from "src/hasura/hasura.controller";
import { Get } from "@nestjs/common";
import { User } from "src/auth/types/User";
import { HasuraService } from "src/hasura/hasura.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { settings_set_input, e_notification_types_enum } from "generated/schema";
import { GameServerNodeService } from "src/game-server-node/game-server-node.service";
import { GameStreamerService } from "src/matches/game-streamer/game-streamer.service";
import { LoggingService } from "src/k8s/logging/logging.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { PassThrough } from "stream";
import { ChatService } from "src/chat/chat.service";
import { SystemSettingName } from "./enums/SystemSettingName";
import { PostgresService } from "src/postgres/postgres.service";

@Controller("system")
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly gameServerNodeService: GameServerNodeService,
    private readonly loggingService: LoggingService,
    private readonly chatService: ChatService,
    private readonly postgres: PostgresService,
  ) {}

  public static readonly NAME_TAKEN_MESSAGE = "That name is already taken";

  // Partial unique index on lower(name) WHERE name_registered (see the
  // players_registered_name_unique migration). It is the last line of
  // defence against two registrations racing past the check below.
  private static readonly NAME_UNIQUE_INDEX = "players_registered_name_unique";

  // Registered names are unique, ignoring case. Players who never
  // registered a name aren't part of the namespace at all.
  public static async isNameTaken(
    postgres: PostgresService,
    name: string,
    exceptSteamId?: string | null,
  ): Promise<boolean> {
    const rows = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM public.players
        WHERE name_registered IS TRUE
          AND lower(name) = lower($1)
          AND ($2::bigint IS NULL OR steam_id <> $2::bigint)
        LIMIT 1`,
      [name, exceptSteamId ?? null],
    );
    return rows.length > 0;
  }

  private static async assertNameAvailable(
    postgres: PostgresService,
    name: string,
    exceptSteamId?: string | null,
  ) {
    if (await SystemController.isNameTaken(postgres, name, exceptSteamId)) {
      throw new Error(SystemController.NAME_TAKEN_MESSAGE);
    }
  }

  // hasura.mutation rethrows the first GraphQL error's message as a plain
  // string, so match on the text either way.
  private static isNameUniqueViolation(error: unknown) {
    const text =
      typeof error === "string" ? error : String((error as Error)?.message);
    return text.includes(SystemController.NAME_UNIQUE_INDEX);
  }

  // Letters, numbers, "-" and "_" only (same restriction as most
  // FACEIT-style platforms) -- blocks lookalike/fullwidth unicode and
  // special-character names copied from "fancy text" generators.
  private static readonly PLAYER_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

  // FACEIT-style length limits; mirrored in the web forms and in the
  // players_registered_name_length check constraint.
  public static readonly PLAYER_NAME_MIN_LENGTH = 3;
  public static readonly PLAYER_NAME_MAX_LENGTH = 15;

  private static assertValidPlayerName(name: string) {
    if (
      name.length < SystemController.PLAYER_NAME_MIN_LENGTH ||
      name.length > SystemController.PLAYER_NAME_MAX_LENGTH
    ) {
      throw new Error(
        `Name must be between ${SystemController.PLAYER_NAME_MIN_LENGTH} and ${SystemController.PLAYER_NAME_MAX_LENGTH} characters`,
      );
    }
    if (!SystemController.PLAYER_NAME_REGEX.test(name)) {
      throw new Error(
        "Name can only contain letters, numbers, - and _",
      );
    }
  }

  @Get("healthz")
  public async status() {
    return;
  }

  @Post("logs/download")
  public async logs(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const user = request.user;

    if (!user || !isRoleAbove(user.role, "administrator")) {
      response.status(403).json({
        message: "Forbidden",
      });
      return;
    }

    const {
      service,
      previous,
      tailLines,
      since,
    }: {
      service: string;
      previous?: boolean;
      tailLines?: number;
      since?: {
        start: string;
        until: string;
      };
    } = request.body;

    if (!service) {
      response.status(400).json({
        message: "service is required",
      });
      return;
    }

    // m- = match jobs, gs- = game-streamer jobs; both read by job-name label.
    const isJob =
      service.startsWith("cs-update:") ||
      service.startsWith("shader-bake:") ||
      service.startsWith("m-") ||
      service.startsWith("gs-");

    const stream = new PassThrough();

    try {
      const filename = `${service}-logs.zip`;

      response.setHeader("Content-Type", "application/zip");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      stream.pipe(response);

      stream.on("error", (error) => {
        if (!response.headersSent) {
          response.status(500).json({
            message: error?.message || "Stream error",
          });
          return;
        }
        response.destroy();
      });

      response.on("close", () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      await this.loggingService.getServiceLogs(
        service.startsWith("cs-update:")
          ? GameServerNodeService.GET_UPDATE_JOB_NAME(
              service.replace("cs-update:", ""),
            )
          : service.startsWith("shader-bake:")
            ? GameStreamerService.GET_BAKE_JOB_NAME(
                service.replace("shader-bake:", ""),
              )
            : service,
        stream,
        tailLines,
        !!previous,
        true,
        isJob,
        since,
      );

      if (stream.readableEnded || stream.destroyed) {
        if (!response.writableEnded) {
          response.end();
        }
      }
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          message:
            error?.body?.message || error.message || "Unable to get logs",
        });
        return;
      }
      stream.destroy();
      response.destroy();
    }
  }

  @HasuraAction()
  public async getMediaServerStats() {
    return await this.system.getMediaServerStats();
  }

  @HasuraAction()
  public async updateServices() {
    await this.system.updateServices();

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async restartService(data: { service: string }) {
    await this.system.restartService(data.service);

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async registerName(data: { user: User; name: string }) {
    SystemController.assertValidPlayerName(data.name);

    // First registration only: the action is callable directly, so without
    // this an already-registered player could rename themselves and skip
    // the approval flow (requestNameChange -> approveNameChange).
    const [current] = await this.postgres.query<
      Array<{ name_registered: boolean | null }>
    >(
      `SELECT name_registered FROM public.players WHERE steam_id = $1::bigint`,
      [data.user.steam_id],
    );
    if (current?.name_registered) {
      throw new Error(
        "Your name is already registered. Request a name change instead.",
      );
    }

    await SystemController.assertNameAvailable(
      this.postgres,
      data.name,
      data.user.steam_id,
    );

    try {
      await this.hasura.mutation({
        update_players_by_pk: {
          __args: {
            pk_columns: {
              steam_id: data.user.steam_id,
            },
            _set: {
              name: data.name,
              name_registered: true,
            },
          },
          __typename: true,
        },
      });
    } catch (error) {
      if (SystemController.isNameUniqueViolation(error)) {
        throw new Error(SystemController.NAME_TAKEN_MESSAGE);
      }
      throw error;
    }

    return {
      success: true,
    };
  }

  // Live check for the registration / name-change forms. Only administrators
  // may ask on behalf of another player (so the target isn't counted as a
  // clash with their own current name).
  @HasuraAction()
  public async isPlayerNameAvailable(data: {
    user?: User;
    name: string;
    steam_id?: string | null;
  }) {
    if (!data.user) {
      throw new Error("Not authenticated");
    }

    const myId = String(data.user.steam_id);
    const targetId = data.steam_id ? String(data.steam_id) : myId;
    if (targetId !== myId && !isRoleAbove(data.user.role, "administrator")) {
      throw new Error("You can only check a name for yourself");
    }

    const name = (data.name ?? "").trim();
    if (!name) {
      return { available: true };
    }

    return {
      available: !(await SystemController.isNameTaken(
        this.postgres,
        name,
        targetId,
      )),
    };
  }

  @HasuraAction()
  public async approveNameChange(data: { name: string; steam_id: string }) {
    // The request was only checked when it was made; someone else may have
    // taken the name while it sat waiting for approval.
    await SystemController.assertNameAvailable(
      this.postgres,
      data.name,
      data.steam_id,
    );

    try {
      await this.hasura.mutation({
        update_players_by_pk: {
          __args: {
            pk_columns: {
              steam_id: data.steam_id,
            },
            _set: {
              name: data.name,
              name_registered: true,
            },
          },
          __typename: true,
        },
      });
    } catch (error) {
      if (SystemController.isNameUniqueViolation(error)) {
        throw new Error(SystemController.NAME_TAKEN_MESSAGE);
      }
      throw error;
    }

    await this.notifications.notifyPlayers(
      "NameChangeApproved" as e_notification_types_enum,
      {
        title: "Name Change Approved",
        message: `Your name change to ${NotificationsService.escapeHtml(data.name)} was approved.`,
        role: "user",
        steamIds: [data.steam_id],
      },
    );

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async denyNameChange(data: { name: string; steam_id: string }) {
    await this.notifications.notifyPlayers(
      "NameChangeDenied" as e_notification_types_enum,
      {
        title: "Name Change Denied",
        message: `Your request to change your name to ${NotificationsService.escapeHtml(data.name)} was denied.`,
        role: "user",
        steamIds: [data.steam_id],
      },
    );

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async requestNameChange(data: {
    user?: User;
    name: string;
    steam_id: string;
  }) {
    // A name change request is self-service only. Administrators rename
    // other players directly through update_players_by_pk instead.
    if (
      !data.user ||
      (data.user.steam_id !== data.steam_id &&
        data.user.role !== "administrator")
    ) {
      throw new Error("You can only request a name change for yourself");
    }

    SystemController.assertValidPlayerName(data.name);
    await SystemController.assertNameAvailable(
      this.postgres,
      data.name,
      data.steam_id,
    );

    const { notifications } = await this.hasura.query({
      notifications: {
        __args: {
          where: {
            type: {
              _eq: "NameChangeRequest",
            },
            entity_id: {
              _eq: data.steam_id,
            },
            is_read: {
              _eq: false,
            },
          },
        },
        __typename: true,
      },
    });

    if (notifications.length > 0) {
      throw new Error("You have already requested a name change");
    }

    const { players_by_pk: player } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: data.steam_id,
        },
        name: true,
      },
    });

    if (!player) {
      throw new Error("Player not found");
    }

    await this.notifications.send(
      "NameChangeRequest",
      {
        message: `Player <a href="/players/${data.steam_id}">${NotificationsService.escapeHtml(player.name)}</a> has requested to change their name to ${NotificationsService.escapeHtml(data.name)}`,
        title: "Name Change Request",
        role: "administrator",
        entity_id: data.steam_id,
      },
      [
        {
          label: "Approve",
          graphql: {
            type: "mutation",
            action: "approveNameChange",
            variables: {
              name: data.name,
              steam_id: data.steam_id,
            },
            selection: {
              success: true,
            },
          },
        },
        {
          label: "Deny",
          graphql: {
            type: "mutation",
            action: "denyNameChange",
            variables: {
              name: data.name,
              steam_id: data.steam_id,
            },
            selection: {
              success: true,
            },
          },
        },
      ],
    );

    return {
      success: true,
    };
  }

  @HasuraEvent()
  public async settings(data: HasuraEventData<settings_set_input>) {
    if (
      (data.new.name === SystemSettingName.DemoNetworkLimiter ||
        data.old.name === SystemSettingName.DemoNetworkLimiter) &&
      (data.op === "INSERT" ||
        data.op === "DELETE" ||
        data.new.value !== data.old.value)
    ) {
      await this.gameServerNodeService.updateDemoNetworkLimiters();
    }

    if (
      (data.new.name === SystemSettingName.ChatMessageTtl ||
        data.old.name === SystemSettingName.ChatMessageTtl) &&
      (data.op === "INSERT" ||
        data.op === "DELETE" ||
        data.new.value !== data.old.value)
    ) {
      const ttl = parseInt(data.new.value, 10);
      await this.chatService.updateChatMessageTTL(
        isNaN(ttl) ? 60 * 60 * 24 : ttl,
      );
    }

    await this.system.updateDefaultOptions();
  }
}
