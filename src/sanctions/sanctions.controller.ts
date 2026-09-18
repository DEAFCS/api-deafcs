import { Controller, Get, Param } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { WebsiteRestrictionsService } from "src/website-restrictions/website-restrictions.service";
import { SanctionsService, SanctionType } from "./sanctions.service";

@Controller("sanctions")
export class SanctionsController {
  constructor(
    private readonly sanctionsService: SanctionsService,
    private readonly websiteRestrictions: WebsiteRestrictionsService,
  ) {}

  @Get("server/:serverId")
  public async serverSanctions(@Param("serverId") serverId: string) {
    return {
      sanctions: await this.sanctionsService.getActiveServerSanctions(serverId),
    };
  }

  @HasuraAction()
  public async sanctionServerPlayer(data: {
    serverId?: string | null;
    steam_id: string;
    type: SanctionType;
    reason?: string | null;
    duration?: number | null;
    evidence_message_id?: string | null;
    also_restrict_website?: boolean;
    user: User;
  }) {
    const {
      serverId,
      steam_id,
      type,
      reason,
      duration,
      evidence_message_id,
      also_restrict_website,
      user,
    } = data;

    const requiredRole =
      type === "website_chat_mute" ||
      type === "website_restriction" ||
      also_restrict_website
        ? "administrator"
        : "moderator";
    if (!user || !isRoleAbove(user.role, requiredRole)) {
      throw Error("you are not allowed to sanction players");
    }

    if (also_restrict_website && type !== "ban") {
      throw Error("website restriction can only be combined with a ban");
    }

    return await this.sanctionsService.sanctionServerPlayer({
      serverId,
      steamId: steam_id,
      type,
      reason,
      duration,
      sanctionedBySteamId: user.steam_id,
      evidenceMessageId: evidence_message_id,
      alsoRestrictWebsite: also_restrict_website,
    });
  }

  @HasuraAction()
  public async unsanctionServerPlayer(data: {
    serverId?: string | null;
    steam_id: string;
    type: SanctionType;
    user: User;
  }) {
    const { serverId, steam_id, type, user } = data;

    const requiredRole =
      type === "website_chat_mute" || type === "website_restriction"
        ? "administrator"
        : "moderator";
    if (!user || !isRoleAbove(user.role, requiredRole)) {
      throw Error("you are not allowed to remove sanctions");
    }

    return await this.sanctionsService.unsanctionServerPlayer({
      serverId,
      steamId: steam_id,
      type,
      revokedBySteamId: user.steam_id,
    });
  }

  @HasuraAction()
  public async websiteRestrictionStatus(data: { user: User }) {
    if (!data.user?.steam_id) {
      throw Error("authentication required");
    }
    return this.websiteRestrictions.getStatus(data.user.steam_id);
  }

  @HasuraAction()
  public async removeAbandonedMatch(data: { id: string; user: User }) {
    const { id, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to remove an abandoned match");
    }

    await this.sanctionsService.removeAbandonedMatch(id);

    return { success: true };
  }

  @HasuraAction()
  public async kickServerPlayer(data: {
    serverId: string;
    steam_id: string;
    reason?: string | null;
    user: User;
  }) {
    const { serverId, steam_id, reason, user } = data;

    if (!user || !isRoleAbove(user.role, "moderator")) {
      throw Error("you are not allowed to kick players");
    }

    return await this.sanctionsService.kickServerPlayer({
      serverId,
      steamId: steam_id,
      reason,
    });
  }
}
