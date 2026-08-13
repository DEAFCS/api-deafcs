import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  ForbiddenException,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../../auth/types/User";
import { isRoleAbove } from "../../utilities/isRoleAbove";
import { InAppNotificationsService } from "./in-app-notifications.service";

@Controller("notifications/in-app")
export class InAppNotificationsController {
  constructor(private readonly inAppNotifications: InAppNotificationsService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // Every toggleable type is returned regardless of the caller's role --
  // the frontend hides adminOnly rows from non-admins itself (same
  // pattern as elsewhere in Settings), this endpoint just describes what
  // exists so both surfaces read from the one list.
  @Get("types")
  public getTypes() {
    return { types: this.inAppNotifications.getTypes() };
  }

  @Get("preferences")
  public async getPreferences(@Req() request: Request) {
    const user = this.requireUser(request);
    return {
      preferences: await this.inAppNotifications.getPreferences(user.steam_id),
    };
  }

  @Post("preferences")
  public async setPreference(
    @Req() request: Request,
    @Body() body: { type: string; enabled: boolean },
  ) {
    const user = this.requireUser(request);
    const config = this.inAppNotifications
      .getTypes()
      .find((t) => t.type === body.type);
    if (config?.adminOnly && !isRoleAbove(user.role, "moderator")) {
      throw new ForbiddenException("admin-only notification type");
    }
    await this.inAppNotifications.setPreference(
      user.steam_id,
      body.type,
      body.enabled,
    );
    return { success: true };
  }
}
