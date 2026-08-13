import { Injectable } from "@nestjs/common";
import { PostgresService } from "../../postgres/postgres.service";
import {
  IN_APP_TOGGLEABLE_TYPES,
  InAppNotificationTypeConfig,
  inAppDefaultEnabled,
  isInAppTypeToggleable,
} from "./in-app-notification-types";

@Injectable()
export class InAppNotificationsService {
  constructor(private readonly postgres: PostgresService) {}

  // adminOnly types are still listed here regardless of the requesting
  // player's role -- the controller/frontend decide whether to render
  // them, this just describes what exists. Filtering who gets to
  // *change* one happens in setPreference below.
  public getTypes(): InAppNotificationTypeConfig[] {
    return IN_APP_TOGGLEABLE_TYPES;
  }

  // Absence of a row falls back to inAppDefaultEnabled(type). Every
  // toggleable type is included even if the player has never touched
  // one, so the frontend never has to guess.
  public async getPreferences(steamId: string): Promise<Record<string, boolean>> {
    const rows = await this.postgres.query<Array<{ type: string; enabled: boolean }>>(
      `SELECT type, enabled FROM public.in_app_notification_preferences WHERE steam_id = $1`,
      [steamId],
    );
    const explicit = new Map(rows.map((r) => [r.type, r.enabled]));
    return Object.fromEntries(
      IN_APP_TOGGLEABLE_TYPES.map(({ type }) => [
        type,
        explicit.get(type) ?? inAppDefaultEnabled(type),
      ]),
    );
  }

  public async setPreference(
    steamId: string,
    type: string,
    enabled: boolean,
  ): Promise<void> {
    if (!isInAppTypeToggleable(type)) {
      throw new Error(`notification type is not toggleable: ${type}`);
    }
    await this.postgres.query(
      `INSERT INTO public.in_app_notification_preferences (steam_id, type, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (steam_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [steamId, type, enabled],
    );
  }
}
