import { ForbiddenException, Injectable } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";

export type WebsiteRestrictionStatus = {
  active: boolean;
  reason: string | null;
  expiresAt: string | null;
  permanent: boolean;
};

@Injectable()
export class WebsiteRestrictionsService {
  constructor(private readonly postgres: PostgresService) {}

  public async getStatus(steamId: string): Promise<WebsiteRestrictionStatus> {
    const rows = await this.postgres.query<
      Array<{ reason: string | null; remove_sanction_date: string | null }>
    >(
      `SELECT reason, remove_sanction_date
         FROM public.player_sanctions
        WHERE player_steam_id = $1::bigint
          AND type = 'website_restriction'
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
        ORDER BY created_at DESC
        LIMIT 1`,
      [steamId],
    );

    const sanction = rows[0];
    return {
      active: Boolean(sanction),
      reason: sanction?.reason ?? null,
      expiresAt: sanction?.remove_sanction_date
        ? new Date(sanction.remove_sanction_date).toISOString()
        : null,
      permanent: Boolean(sanction && !sanction.remove_sanction_date),
    };
  }

  public async assertCanParticipate(steamId: string): Promise<void> {
    if ((await this.getStatus(steamId)).active) {
      throw new ForbiddenException(
        "Your DEAFCS account is restricted to read-only access.",
      );
    }
  }
}
