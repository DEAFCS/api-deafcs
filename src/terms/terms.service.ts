import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";

// Single source of truth for reading/checking/recording Terms of Service
// acceptance, so the ~20 Hasura Action handlers that must not proceed
// without current acceptance don't each duplicate the version lookup.
// Mirrors the SQL primitives in hasura/functions/players/ -- the players
// computed field and the draft_game_picks trigger both re-derive the same
// answer independently since NestJS isn't in either of those paths.
@Injectable()
export class TermsService {
  private static readonly SETTING_NAME = "public.terms_version";

  constructor(private readonly postgres: PostgresService) {}

  // Missing/blank setting means "no version configured" -- never treated as
  // a version string, so callers fail closed instead of matching anything.
  public async getCurrentVersion(): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [TermsService.SETTING_NAME],
    );

    return row?.value ? row.value : null;
  }

  public async hasAcceptedCurrentTerms(steamId: string): Promise<boolean> {
    const version = await this.getCurrentVersion();
    if (!version) {
      return false;
    }

    const [row] = await this.postgres.query<Array<{ accepted: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.player_terms_acceptances
         WHERE player_steam_id = $1 AND terms_version = $2
       ) AS accepted`,
      [steamId, version],
    );

    return row?.accepted === true;
  }

  public async assertAccepted(steamId: string): Promise<void> {
    if (!(await this.hasAcceptedCurrentTerms(steamId))) {
      throw new ForbiddenException(
        "You must accept the current Terms of Service and DEAFCS Rules before doing this.",
      );
    }
  }

  // Idempotent: accepting the same version twice is a no-op, not an error.
  // Throws if no version is configured -- there is nothing valid to record.
  public async acceptCurrentTerms(
    steamId: string,
  ): Promise<{ terms_version: string }> {
    const version = await this.getCurrentVersion();
    if (!version) {
      throw new BadRequestException(
        "No Terms of Service version is currently configured.",
      );
    }

    await this.postgres.query(
      `INSERT INTO public.player_terms_acceptances (player_steam_id, terms_version)
       VALUES ($1, $2)
       ON CONFLICT (player_steam_id, terms_version) DO NOTHING`,
      [steamId, version],
    );

    return { terms_version: version };
  }
}
