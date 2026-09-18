import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { User } from "src/auth/types/User";
import { WebsiteRestrictionsService } from "./website-restrictions.service";

const READ_ONLY_ACTIONS = new Set([
  "teamCalendarUrl",
  "getHighlightPresetAvailability",
  "dbStats",
  "getActiveConnections",
  "getActiveQueries",
  "getConnectionStats",
  "getCurrentLocks",
  "getDatabaseStats",
  "getDedicatedServerInfo",
  "getDedicatedServerPlayers",
  "getIndexIOStats",
  "getIndexStats",
  "getNodeStats",
  "getQueryDetail",
  "getQueryStats",
  "getSchemas",
  "getServiceStats",
  "getMediaServerStats",
  "getStorageStats",
  "getTableIOStats",
  "getTableStats",
  "getTimescaleStats",
  "listServerFiles",
  "me",
  "newsPostsAdmin",
  "newsPostAdmin",
  "readServerFile",
  "telemetryStats",
  "steamPresenceAdminStatus",
  "websiteRestrictionStatus",
]);

const ESSENTIAL_ACCOUNT_ACTIONS = new Set([
  "logout",
  "acceptTerms",
  "registerName",
  "requestNameChange",
  "unlinkDiscord",
  "unlinkSteamMatchHistory",
]);

@Injectable()
export class WebsiteRestrictionGuard implements CanActivate {
  constructor(
    private readonly websiteRestrictions: WebsiteRestrictionsService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return true;
    }

    const user = request.user as User | undefined;
    if (!user?.steam_id) {
      return true;
    }

    const actionName = (request.body as any)?.action?.name as
      | string
      | undefined;
    if (
      actionName &&
      (READ_ONLY_ACTIONS.has(actionName) ||
        ESSENTIAL_ACCOUNT_ACTIONS.has(actionName))
    ) {
      return true;
    }

    await this.websiteRestrictions.assertCanParticipate(user.steam_id);
    return true;
  }
}
