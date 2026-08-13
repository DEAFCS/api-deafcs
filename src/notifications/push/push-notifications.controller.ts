import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Req,
  ForbiddenException,
} from "@nestjs/common";
import { Request } from "express";
import { HasuraEvent } from "../../hasura/hasura.controller";
import { HasuraEventData } from "../../hasura/types/HasuraEventData";
import { User } from "../../auth/types/User";
import {
  PushNotificationsService,
  PushSubscriptionPayload,
} from "./push-notifications.service";

type NotificationRow = {
  steam_id: string | null;
  role: string;
  title: string;
  message: string;
  type: string;
  entity_id: string;
};

@Controller("notifications/push")
export class PushNotificationsController {
  constructor(private readonly pushNotifications: PushNotificationsService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  @Get("vapid-public-key")
  public getPublicKey() {
    return { publicKey: this.pushNotifications.getPublicKey() };
  }

  @Get("categories")
  public getCategories() {
    return { categories: this.pushNotifications.getCategories() };
  }

  @Get("preferences")
  public async getPreferences(@Req() request: Request) {
    const user = this.requireUser(request);
    return { preferences: await this.pushNotifications.getPreferences(user.steam_id) };
  }

  @Post("preferences")
  public async setPreference(
    @Req() request: Request,
    @Body() body: { category: string; enabled: boolean },
  ) {
    const user = this.requireUser(request);
    await this.pushNotifications.setPreference(user.steam_id, body.category, body.enabled);
    return { success: true };
  }

  @Post("subscribe")
  public async subscribe(
    @Req() request: Request,
    @Body() body: { subscription: PushSubscriptionPayload },
  ) {
    const user = this.requireUser(request);
    await this.pushNotifications.subscribe(
      user.steam_id,
      body.subscription,
      request.headers["user-agent"],
    );
    return { success: true };
  }

  @Delete("subscribe")
  public async unsubscribe(
    @Req() request: Request,
    @Body() body: { endpoint: string },
  ) {
    const user = this.requireUser(request);
    await this.pushNotifications.unsubscribe(user.steam_id, body.endpoint);
    return { success: true };
  }

  // Hasura event trigger on public.notifications (INSERT) — see
  // hasura/metadata/databases/default/tables/public_notifications.yaml.
  // Method name must match the trigger's `name` exactly (see
  // HasuraController.events / the `_events` registry).
  @HasuraEvent()
  public async notification_events(data: HasuraEventData<NotificationRow>) {
    if (data.op !== "INSERT") return;
    await this.pushNotifications.handleNotificationInsert(data.new);
  }
}
