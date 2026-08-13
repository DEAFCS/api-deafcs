import { Injectable, Logger } from "@nestjs/common";
import * as webPush from "web-push";
import { PostgresService } from "../../postgres/postgres.service";
import { isRoleAbove } from "../../utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import {
  NOTIFICATION_CATEGORY_KEYS,
  categoryForType,
} from "./notification-categories";

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

type SubscriptionRow = {
  id: string;
  steam_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// The only integration point for outbound Web Push: every existing
// notification-creation call site (NotificationsService.send /
// notifyPlayers / insertNotification, leagues.service.ts, etc.)
// already funnels into a single INSERT on the `notifications` table.
// A Hasura event trigger on that table calls back into
// handleNotificationInsert below, so this is the one place Web Push
// needs to be wired up rather than touching every call site.
@Injectable()
export class PushNotificationsService {
  private readonly vapidConfigured: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || "mailto:hello@deafcs.net";

    this.vapidConfigured = Boolean(publicKey && privateKey);
    if (this.vapidConfigured) {
      webPush.setVapidDetails(subject, publicKey as string, privateKey as string);
    } else {
      this.logger.warn(
        "[push] VAPID keys not configured — push notifications are disabled",
      );
    }
  }

  public getPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
  }

  public async subscribe(
    steamId: string,
    subscription: PushSubscriptionPayload,
    userAgent?: string,
  ): Promise<void> {
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new Error("invalid push subscription payload");
    }

    await this.postgres.query(
      `INSERT INTO public.push_subscriptions (steam_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         steam_id = EXCLUDED.steam_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         last_used_at = now()`,
      [steamId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent ?? null],
    );
  }

  public async unsubscribe(steamId: string, endpoint: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM public.push_subscriptions WHERE steam_id = $1 AND endpoint = $2`,
      [steamId, endpoint],
    );
  }

  public getCategories(): string[] {
    return NOTIFICATION_CATEGORY_KEYS;
  }

  // Absence of a row means enabled -- see push_notification_preferences'
  // migration comment. Every known category is included in the result
  // even if the player has never touched one, so the frontend never has
  // to guess a default.
  public async getPreferences(steamId: string): Promise<Record<string, boolean>> {
    const rows = await this.postgres.query<Array<{ category: string; enabled: boolean }>>(
      `SELECT category, enabled FROM public.push_notification_preferences WHERE steam_id = $1`,
      [steamId],
    );
    const disabled = new Set(rows.filter((r) => !r.enabled).map((r) => r.category));
    return Object.fromEntries(
      NOTIFICATION_CATEGORY_KEYS.map((category) => [category, !disabled.has(category)]),
    );
  }

  public async setPreference(
    steamId: string,
    category: string,
    enabled: boolean,
  ): Promise<void> {
    if (!NOTIFICATION_CATEGORY_KEYS.includes(category)) {
      throw new Error(`unknown notification category: ${category}`);
    }
    await this.postgres.query(
      `INSERT INTO public.push_notification_preferences (steam_id, category, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (steam_id, category) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [steamId, category, enabled],
    );
  }

  // Called by the Hasura event trigger (see PushNotificationsController)
  // on every INSERT into `notifications`. Targeted (steam_id set) rows
  // send to just that player's devices; broadcast (steam_id null) rows
  // approximate the existing role-gated visibility rules by sending to
  // every player whose own role satisfies isRoleAbove(player.role,
  // notification.role) — the same "at least this role" relationship
  // the rest of the app already uses for role checks.
  public async handleNotificationInsert(notification: {
    steam_id: string | null;
    role: string;
    title: string;
    message: string;
    type: string;
    entity_id: string;
  }): Promise<void> {
    if (!this.vapidConfigured) return;

    let rows: SubscriptionRow[];
    if (notification.steam_id) {
      rows = await this.postgres.query<SubscriptionRow[]>(
        `SELECT id, steam_id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE steam_id = $1`,
        [notification.steam_id],
      );
    } else {
      const targetRole = notification.role as e_player_roles_enum;
      const withRole = await this.postgres.query<
        Array<SubscriptionRow & { player_role: e_player_roles_enum }>
      >(
        `SELECT ps.id, ps.steam_id, ps.endpoint, ps.p256dh, ps.auth, p.role AS player_role
         FROM public.push_subscriptions ps
         JOIN public.players p ON p.steam_id = ps.steam_id`,
      );
      rows = withRole.filter((row) => isRoleAbove(row.player_role, targetRole));
    }

    if (!rows.length) return;

    const category = categoryForType(notification.type);
    if (category) {
      rows = await this.filterByPreference(rows, category);
      if (!rows.length) return;
    }

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.message,
      type: notification.type,
      entity_id: notification.entity_id,
    });

    await Promise.all(rows.map((row) => this.sendToSubscription(row, payload)));
  }

  private async filterByPreference(
    rows: SubscriptionRow[],
    category: string,
  ): Promise<SubscriptionRow[]> {
    const steamIds = [...new Set(rows.map((r) => r.steam_id))];
    const disabledRows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id FROM public.push_notification_preferences
       WHERE category = $1 AND enabled = false AND steam_id = ANY($2)`,
      [category, steamIds],
    );
    if (!disabledRows.length) return rows;
    const disabled = new Set(disabledRows.map((r) => r.steam_id));
    return rows.filter((row) => !disabled.has(row.steam_id));
  }

  private async sendToSubscription(row: SubscriptionRow, payload: string): Promise<void> {
    try {
      await webPush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        payload,
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      // 404/410 == the push service itself says this subscription is
      // gone (uninstalled PWA, cleared site data, etc.) — clean it up
      // so we stop paying the round-trip on every future notification.
      if (statusCode === 404 || statusCode === 410) {
        await this.postgres
          .query(`DELETE FROM public.push_subscriptions WHERE id = $1`, [row.id])
          .catch(() => {});
        return;
      }
      this.logger.warn(
        `[push] send failed for subscription ${row.id}: ${(error as Error)?.message}`,
      );
    }
  }
}
