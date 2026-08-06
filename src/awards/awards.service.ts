import crypto from "crypto";
import { Readable } from "stream";
import { PoolClient } from "pg";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const AWARD_TIERS = ["mvp", "gold", "silver", "bronze", "special"];

export interface AwardRow {
  id: string;
  name: string;
  description: string | null;
  tier: string;
  silhouette: number | null;
  image_url: string | null;
  system_key: string | null;
  allow_multiple: boolean;
  tournament_id: string | null;
  event_id: string | null;
  elo_season_id: string | null;
  league_season_id: string | null;
  created_by_steam_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrantAwardInput {
  award_id: string;
  player_steam_id?: string | null;
  team_id?: string | null;
  tournament_id?: string | null;
  event_id?: string | null;
  elo_season_id?: string | null;
  league_season_id?: string | null;
  note?: string | null;
  awarded_by_steam_id: string;
}

interface TournamentAwardRow {
  id: string;
  tournament_id: string;
  placement: number;
  award_id: string | null;
  custom_name: string | null;
  silhouette: number | null;
  image_url: string | null;
}

@Injectable()
export class AwardsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly postgres: PostgresService,
  ) {}

  public async listAwards(): Promise<AwardRow[]> {
    return await this.postgres.query<AwardRow[]>(
      `SELECT * FROM public.awards ORDER BY system_key NULLS LAST, name ASC`,
    );
  }

  public async saveAward(
    input: {
      id?: string | null;
      name: string;
      description?: string | null;
      tier: string;
      silhouette?: number | null;
      allow_multiple?: boolean | null;
      tournament_id?: string | null;
      event_id?: string | null;
      elo_season_id?: string | null;
      league_season_id?: string | null;
    },
    steamId: string,
  ): Promise<AwardRow> {
    if (!AWARD_TIERS.includes(input.tier)) {
      throw new BadRequestException("Invalid award tier");
    }
    if (!input.name?.trim()) {
      throw new BadRequestException("Award name is required");
    }
    if (!this.isValidSilhouette(input.silhouette)) {
      throw new BadRequestException("Invalid silhouette");
    }

    this.assertSingleScope(input);

    if (!input.id) {
      const [created] = await this.postgres.query<AwardRow[]>(
        `INSERT INTO public.awards
            (name, description, tier, silhouette, allow_multiple,
             created_by_steam_id, tournament_id, event_id, elo_season_id,
             league_season_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *`,
        [
          input.name.trim(),
          input.description ?? null,
          input.tier,
          input.silhouette ?? null,
          input.allow_multiple ?? false,
          steamId,
          input.tournament_id ?? null,
          input.event_id ?? null,
          input.elo_season_id ?? null,
          input.league_season_id ?? null,
        ],
      );
      return created;
    }

    const [updated] = await this.postgres.query<AwardRow[]>(
      `UPDATE public.awards
          SET name = $2,
              description = $3,
              tier = $4,
              silhouette = $5,
              allow_multiple = $6,
              tournament_id = $7,
              event_id = $8,
              elo_season_id = $9,
              league_season_id = $10,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        input.id,
        input.name.trim(),
        input.description ?? null,
        input.tier,
        input.silhouette ?? null,
        input.allow_multiple ?? false,
        input.tournament_id ?? null,
        input.event_id ?? null,
        input.elo_season_id ?? null,
        input.league_season_id ?? null,
      ],
    );

    if (!updated) {
      throw new NotFoundException("Award not found");
    }

    return updated;
  }

  public async deleteAward(awardId: string): Promise<void> {
    const award = await this.requireAward(awardId);

    if (award.system_key) {
      throw new ForbiddenException(
        "Built-in tournament awards cannot be deleted",
      );
    }

    await this.postgres.query(`DELETE FROM public.awards WHERE id = $1`, [
      awardId,
    ]);

    if (award.image_url) {
      await this.s3.remove(award.image_url);
    }
  }

  public async archiveAward(
    awardId: string,
    archived: boolean,
    steamId: string,
  ): Promise<AwardRow> {
    const award = await this.requireAward(awardId);
    if (award.system_key)
      throw new ForbiddenException("Built-in awards cannot be archived");
    const [updated] = await this.postgres.query<AwardRow[]>(
      `UPDATE public.awards SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END,archived_by=CASE WHEN $2 THEN $3::bigint ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
      [awardId, archived, steamId],
    );
    return updated;
  }
  public async grantAward(input: GrantAwardInput) {
    const hasPlayer = !!input.player_steam_id;
    const hasTeam = !!input.team_id;
    if (hasPlayer === hasTeam) {
      throw new BadRequestException(
        "An award goes to exactly one player or one team",
      );
    }
    this.assertSingleScope(input);
    const award = await this.requireAward(input.award_id);
    if (award.archived_at) {
      throw new BadRequestException("Archived awards cannot be granted");
    }
    let tournamentTeamId: string | null = null;
    if (input.tournament_id) {
      tournamentTeamId = await this.resolveTournamentTeam(
        input.tournament_id,
        input.player_steam_id ?? null,
        input.team_id ?? null,
      );
    }
    return await this.postgres.transaction(async (client) => {
      if (!award.allow_multiple) {
        const duplicate = await client.query<{ id: string }>(
          `SELECT r.id
             FROM public.award_recipients r
             JOIN public.award_occurrences o ON o.id=r.occurrence_id
            WHERE o.award_id=$1
              AND o.tournament_id IS NOT DISTINCT FROM $2
              AND o.event_id IS NOT DISTINCT FROM $3
              AND o.elo_season_id IS NOT DISTINCT FROM $4
              AND o.league_season_id IS NOT DISTINCT FROM $5
              AND r.revoked_at IS NULL
              AND (($6::bigint IS NOT NULL AND r.player_steam_id=$6)
                OR ($7::uuid IS NOT NULL AND r.team_id=$7))
            LIMIT 1`,
          [
            input.award_id,
            input.tournament_id ?? null,
            input.event_id ?? null,
            input.elo_season_id ?? null,
            input.league_season_id ?? null,
            input.player_steam_id ?? null,
            input.team_id ?? null,
          ],
        );
        if (duplicate.rows.length) {
          throw new BadRequestException(
            "Award already granted to this recipient",
          );
        }
      }

      const occurrenceResult = await client.query<{ id: string }>(
        `INSERT INTO public.award_occurrences
          (award_id,tournament_id,event_id,elo_season_id,league_season_id,source,note,awarded_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7) RETURNING id`,
        [
          input.award_id,
          input.tournament_id ?? null,
          input.event_id ?? null,
          input.elo_season_id ?? null,
          input.league_season_id ?? null,
          input.note ?? null,
          input.awarded_by_steam_id,
        ],
      );
      const occurrence = occurrenceResult.rows[0];
      const grantedResult = await client.query<{ id: string }>(
        `INSERT INTO public.award_recipients
          (occurrence_id,player_steam_id,team_id,tournament_team_id,recipient_note)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [
          occurrence.id,
          input.player_steam_id ?? null,
          input.team_id ?? null,
          tournamentTeamId,
          input.note ?? null,
        ],
      );
      if (input.team_id) {
        await this.grantToRoster(
          client,
          occurrence.id,
          input.team_id,
          tournamentTeamId,
        );
      }
      return grantedResult.rows[0];
    });
  }
  public assertSingleScope(input: {
    tournament_id?: string | null;
    event_id?: string | null;
    elo_season_id?: string | null;
    league_season_id?: string | null;
  }): void {
    const scopes = [
      input.tournament_id,
      input.event_id,
      input.elo_season_id,
      input.league_season_id,
    ].filter(Boolean);

    if (scopes.length > 1) {
      throw new BadRequestException("An award belongs to one scope at most");
    }
  }

  public async requireOrganizerGrantableAward(
    awardId: string,
    tournamentId: string,
  ): Promise<void> {
    const award = await this.requireAward(awardId);
    if (award.tier !== "special") {
      throw new ForbiddenException(
        "Tournament organizers can only grant special awards",
      );
    }
    if (award.tournament_id && award.tournament_id !== tournamentId) {
      throw new ForbiddenException("This award belongs to another tournament");
    }
  }

  public async requireTournamentSlotAward(
    awardId: string,
    tournamentId: string,
  ): Promise<void> {
    const award = await this.requireAward(awardId);
    if (award.archived_at) {
      throw new BadRequestException("Archived awards cannot be selected");
    }
    if (
      award.event_id ||
      award.elo_season_id ||
      award.league_season_id ||
      (award.tournament_id && award.tournament_id !== tournamentId)
    ) {
      throw new ForbiddenException(
        "This award is not available to this tournament",
      );
    }
  }

  public async requireAwardManager(awardId: string, user: User): Promise<void> {
    if (user.role === "administrator") {
      return;
    }
    const award = await this.requireAward(awardId);
    if (!award.tournament_id) {
      throw new ForbiddenException(
        "Only administrators can manage shared awards",
      );
    }
    await this.requireOrganizer(award.tournament_id, user);
  }

  public async getRecipient(recipientId: string) {
    const [recipient] = await this.postgres.query<
      Array<{
        id: string;
        award_id: string;
        source: string;
        tournament_id: string | null;
        event_id: string | null;
        elo_season_id: string | null;
        league_season_id: string | null;
      }>
    >(
      `SELECT r.id,o.award_id,o.source,o.tournament_id,o.event_id,o.elo_season_id,o.league_season_id
       FROM public.award_recipients r JOIN public.award_occurrences o ON o.id=r.occurrence_id
       WHERE r.id=$1 LIMIT 1`,
      [recipientId],
    );
    if (!recipient) throw new NotFoundException("Award grant not found");
    return recipient;
  }

  public async revokeAward(
    recipientId: string,
    steamId: string,
    reason: string,
  ): Promise<void> {
    const recipient = await this.getRecipient(recipientId);
    if (recipient.source !== "manual") {
      throw new ForbiddenException(
        "Calculated tournament awards are managed by the tournament",
      );
    }
    if (!reason?.trim())
      throw new BadRequestException("A revocation reason is required");
    await this.postgres.query(
      `UPDATE public.award_recipients SET revoked_at=now(),revoked_by=$2,revocation_reason=$3 WHERE id=$1 AND revoked_at IS NULL`,
      [recipientId, steamId, reason.trim()],
    );
  }
  public async setTournamentAward(input: {
    tournament_id: string;
    placement: number;
    award_id?: string | null;
    custom_name?: string | null;
    silhouette?: number | null;
  }): Promise<TournamentAwardRow> {
    if (!this.isValidPlacement(input.placement)) {
      throw new BadRequestException("Invalid placement");
    }
    if (!this.isValidSilhouette(input.silhouette)) {
      throw new BadRequestException("Invalid silhouette");
    }
    if (input.award_id) {
      await this.requireTournamentSlotAward(
        input.award_id,
        input.tournament_id,
      );
    }

    const [config] = await this.postgres.query<TournamentAwardRow[]>(
      `INSERT INTO public.tournament_award_slots
          (tournament_id, slot, award_id, custom_name, silhouette_override)
        VALUES ($1, $2, COALESCE($3, public.resolve_tournament_award($1, $6)), $4, $5)
        ON CONFLICT (tournament_id, slot) DO UPDATE
          SET award_id = EXCLUDED.award_id,
              custom_name = EXCLUDED.custom_name,
              silhouette_override = EXCLUDED.silhouette_override,
              updated_at = now()
        RETURNING *`,
      [
        input.tournament_id,
        this.slotForPlacement(input.placement),
        input.award_id ?? null,
        input.custom_name ?? null,
        input.silhouette ?? null,
        input.placement,
      ],
    );

    return {
      ...config,
      placement: input.placement,
      silhouette: input.silhouette ?? null,
    };
  }

  public async uploadAwardImage(
    awardId: string,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const award = await this.requireAward(awardId);
    const path = this.buildPath(awardId, mimetype);

    await this.s3.put(path, buffer);
    try {
      await this.postgres.query(
        `UPDATE public.awards SET image_url = $1, updated_at = now() WHERE id = $2`,
        [path, awardId],
      );
    } catch (error) {
      await this.s3.remove(path);
      throw error;
    }

    if (award.image_url && award.image_url !== path) {
      await this.s3.remove(award.image_url);
    }

    this.logger.log(`Uploaded award ${awardId} image to ${path}`);
    return path;
  }

  public async removeAwardImage(awardId: string): Promise<void> {
    const award = await this.requireAward(awardId);
    if (!award.image_url) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.awards SET image_url = NULL, updated_at = now() WHERE id = $1`,
      [awardId],
    );
    await this.s3.remove(award.image_url);
  }

  public async uploadTournamentAwardImage(
    tournamentId: string,
    placement: number,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (!this.isValidPlacement(placement)) {
      throw new BadRequestException("Invalid placement");
    }

    const existing = await this.getTournamentAward(tournamentId, placement);
    const path = this.buildPath(`${tournamentId}-${placement}`, mimetype);

    await this.s3.put(path, buffer);
    try {
      if (existing) {
        await this.postgres.query(
          `UPDATE public.tournament_award_slots
              SET image_override = $1, updated_at = now()
            WHERE id = $2`,
          [path, existing.id],
        );
      } else {
        await this.postgres.query(
          `INSERT INTO public.tournament_award_slots
              (tournament_id, slot, award_id, image_override)
            VALUES ($1, $2, public.resolve_tournament_award($1, $4), $3)`,
          [tournamentId, this.slotForPlacement(placement), path, placement],
        );
      }
    } catch (error) {
      await this.s3.remove(path);
      throw error;
    }

    if (existing?.image_url && existing.image_url !== path) {
      await this.s3.remove(existing.image_url);
    }

    this.logger.log(
      `Uploaded tournament ${tournamentId} placement ${placement} award image to ${path}`,
    );
    return path;
  }

  public async removeTournamentAwardImage(
    tournamentId: string,
    placement: number,
  ): Promise<void> {
    if (!this.isValidPlacement(placement)) {
      throw new BadRequestException("Invalid placement");
    }

    const existing = await this.getTournamentAward(tournamentId, placement);
    if (!existing) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.tournament_award_slots
          SET image_override = NULL, updated_at = now()
        WHERE id = $1`,
      [existing.id],
    );
    if (existing.image_url) {
      await this.s3.remove(existing.image_url);
    }
  }

  public async getStream(
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    // Images uploaded before the awards rename still live under `trophies/`
    // and their keys are stored verbatim in image_url.
    let key = `awards/${filename}`;

    if (!(await this.s3.has(key))) {
      key = `trophies/${filename}`;
      if (!(await this.s3.has(key))) {
        return null;
      }
    }

    const [stream, stat] = await Promise.all([
      this.s3.get(key),
      this.s3.stat(key),
    ]);

    return {
      stream,
      contentType:
        stat.metaData?.["content-type"] || this.guessContentType(filename),
      etag: stat.etag,
    };
  }

  public async requireOrganizer(
    tournamentId: string,
    user: User,
  ): Promise<void> {
    const rows = await this.postgres.query<
      Array<{ organizer_steam_id: string | null }>
    >(
      `SELECT organizer_steam_id
         FROM public.tournaments
        WHERE id = $1
        LIMIT 1`,
      [tournamentId],
    );

    if (!rows || rows.length === 0) {
      throw new ForbiddenException("Tournament not found");
    }

    const isOrganizer =
      String(rows[0].organizer_steam_id) === String(user.steam_id);

    if (isOrganizer || user.role === "administrator") {
      return;
    }

    const coOrg = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id
         FROM public.tournament_organizers
        WHERE tournament_id = $1 AND steam_id = $2
        LIMIT 1`,
      [tournamentId, user.steam_id],
    );
    if (coOrg && coOrg.length > 0) {
      return;
    }

    throw new ForbiddenException("Not the tournament organizer");
  }

  private async requireAward(awardId: string): Promise<AwardRow> {
    const [award] = await this.postgres.query<AwardRow[]>(
      `SELECT * FROM public.awards WHERE id = $1 LIMIT 1`,
      [awardId],
    );

    if (!award) {
      throw new NotFoundException("Award not found");
    }

    return award;
  }

  private async getTournamentAward(
    tournamentId: string,
    placement: number,
  ): Promise<TournamentAwardRow | null> {
    const rows = await this.postgres.query<TournamentAwardRow[]>(
      `SELECT *, image_override AS image_url, silhouette_override AS silhouette FROM public.tournament_award_slots
        WHERE tournament_id = $1 AND slot = $2
        LIMIT 1`,
      [tournamentId, this.slotForPlacement(placement)],
    );
    return rows?.[0] || null;
  }

  // Called from within TournamentsController's PostgresService.transaction
  // block, immediately before the tournament row itself is deleted. Deletes
  // are scoped strictly by tournament_id: recipients first (award_recipients
  // -> award_occurrences is ON DELETE RESTRICT, so it must go first), then the
  // occurrences themselves. This covers both tournament_calculated and manual
  // occurrences tied to this tournament -- award_occurrences_calculated_tournament
  // requires tournament_id IS NOT NULL for calculated rows, so leaving any
  // tournament_calculated occurrence behind while nulling this column (which is
  // what deleting the tournament via ON DELETE SET NULL would otherwise do)
  // is exactly the violation this method exists to avoid. Reusable/unscoped
  // award definitions in `awards` are never touched here.
  public async deleteTournamentAwardRecords(
    client: PoolClient,
    tournamentId: string,
  ): Promise<void> {
    await client.query(
      `DELETE FROM public.award_recipients
        WHERE occurrence_id IN (
          SELECT id FROM public.award_occurrences WHERE tournament_id = $1
        )`,
      [tournamentId],
    );
    await client.query(
      `DELETE FROM public.award_occurrences WHERE tournament_id = $1`,
      [tournamentId],
    );
  }

  // A team award has to reach the people on the team, otherwise it only ever
  // shows on the team page. Tournament placements already work this way — the
  // calculation writes one team row plus a row per roster player — so a
  // hand-granted team award fans out the same way. Invites are skipped, and
  // members who already hold the award are filtered out here rather than left
  // to ON CONFLICT: tbi_award_recipients raises on a duplicate instead of
  // conflicting, so one existing holder would otherwise fail the whole grant.
  private async grantToRoster(
    client: PoolClient,
    occurrenceId: string,
    teamId: string,
    tournamentTeamId: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.award_recipients
        (occurrence_id,player_steam_id,tournament_team_id)
       SELECT $1, roster.player_steam_id, $2
       FROM public.team_roster roster
       JOIN public.award_occurrences target ON target.id=$1
       WHERE roster.team_id=$3
         AND roster.role <> 'Invite'
         AND NOT EXISTS (
           SELECT 1
             FROM public.award_recipients held
             JOIN public.award_occurrences held_occurrence
               ON held_occurrence.id=held.occurrence_id
            WHERE held.player_steam_id=roster.player_steam_id
              AND held.revoked_at IS NULL
              AND held_occurrence.award_id=target.award_id
              AND held_occurrence.tournament_id IS NOT DISTINCT FROM target.tournament_id
              AND held_occurrence.event_id IS NOT DISTINCT FROM target.event_id
              AND held_occurrence.elo_season_id IS NOT DISTINCT FROM target.elo_season_id
              AND held_occurrence.league_season_id IS NOT DISTINCT FROM target.league_season_id
         )
       ON CONFLICT DO NOTHING`,
      [occurrenceId, tournamentTeamId, teamId],
    );
  }
  // A tournament-scoped grant must name the entry the recipient played as: it
  // keeps the award tied to an actual participant, and lets the partial unique
  // keys dedupe the grant against the calculated rows.
  private async resolveTournamentTeam(
    tournamentId: string,
    playerSteamId: string | null,
    teamId: string | null,
  ): Promise<string> {
    const rows = teamId
      ? await this.postgres.query<Array<{ id: string }>>(
          `SELECT id FROM public.tournament_teams
            WHERE tournament_id = $1 AND team_id = $2
            LIMIT 1`,
          [tournamentId, teamId],
        )
      : await this.postgres.query<Array<{ id: string }>>(
          `SELECT tournament_team_id AS id
             FROM public.tournament_team_roster
            WHERE tournament_id = $1 AND player_steam_id = $2
            LIMIT 1`,
          [tournamentId, playerSteamId],
        );

    if (!rows || rows.length === 0) {
      throw new BadRequestException("Recipient is not part of this tournament");
    }

    return rows[0].id;
  }

  private slotForPlacement(placement: number): string {
    return (["mvp", "champion", "runner_up", "third_place"] as const)[
      placement
    ];
  }

  private isValidPlacement(placement: number): boolean {
    return Number.isInteger(placement) && placement >= 0 && placement <= 3;
  }

  private isValidSilhouette(silhouette?: number | null): boolean {
    if (silhouette === null || silhouette === undefined) {
      return true;
    }
    return Number.isInteger(silhouette) && silhouette >= 0 && silhouette <= 4;
  }

  private buildPath(slug: string, mimetype: string): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `awards/${slug}-${hash}.${ext}`;
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) {
      return "image/png";
    }
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (filename.endsWith(".webp")) {
      return "image/webp";
    }
    return "application/octet-stream";
  }
}
