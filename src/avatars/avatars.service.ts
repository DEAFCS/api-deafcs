import crypto from "crypto";
import { Readable } from "stream";
import { PoolClient } from "pg";
import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";

export type AvatarKind =
  | "teams"
  | "players"
  | "roster-players"
  | "roster-teams"
  | "tournaments";

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type ReplacedRosterImage = {
  oldPath: string | null;
  newPath: string | null;
  referenced: boolean;
};

@Injectable()
export class AvatarsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
  ) {}

  async uploadTeamAvatar(
    teamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    const path = this.buildPath("teams", teamId, mimetype);

    await this.s3.put(path, buffer);

    if (teams_by_pk.avatar_url && teams_by_pk.avatar_url !== path) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded team ${teamId} avatar to ${path}`);
    return path;
  }

  async removeTeamAvatar(teamId: string, user: User): Promise<void> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        owner_steam_id: true,
        avatar_url: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }

    if (
      teams_by_pk.owner_steam_id !== user.steam_id &&
      user.role !== "administrator"
    ) {
      throw new ForbiddenException("You do not own this team");
    }

    if (teams_by_pk.avatar_url) {
      await this.s3.remove(teams_by_pk.avatar_url);
    }

    await this.hasura.mutation({
      update_teams_by_pk: {
        __args: {
          pk_columns: { id: teamId },
          _set: { avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed team ${teamId} avatar`);
  }

  async uploadPlayerAvatar(
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const path = this.buildPath("players", steamId, mimetype);

    await this.s3.put(path, buffer);

    if (
      players_by_pk.custom_avatar_url &&
      players_by_pk.custom_avatar_url !== path
    ) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded player ${steamId} avatar to ${path}`);
    return path;
  }

  async removePlayerAvatar(steamId: string, user: User): Promise<void> {
    if (steamId !== user.steam_id && user.role !== "administrator") {
      throw new ForbiddenException("You cannot change this player's avatar");
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        custom_avatar_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    if (players_by_pk.custom_avatar_url) {
      await this.s3.remove(players_by_pk.custom_avatar_url);
    }

    await this.hasura.mutation({
      update_players_by_pk: {
        __args: {
          pk_columns: { steam_id: steamId },
          _set: { custom_avatar_url: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed player ${steamId} custom avatar`);
  }

  async uploadPlayerRosterImage(
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    if (!isRoleAbove(user.role, "tournament_organizer")) {
      throw new ForbiddenException(
        "You do not have permission to manage roster images",
      );
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        roster_image_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const path = this.buildPath("roster-players", steamId, mimetype);

    await this.s3.put(path, buffer);

    let replaced: ReplacedRosterImage;
    try {
      replaced = await this.replacePlayerRosterImagePointer(steamId, path);
    } catch (error) {
      await this.s3.remove(path);
      throw error;
    }
    await this.removeUnreferencedRosterImage(replaced);

    this.logger.log(`Uploaded player ${steamId} roster image to ${path}`);
    return path;
  }

  async removePlayerRosterImage(steamId: string, user: User): Promise<void> {
    if (!isRoleAbove(user.role, "tournament_organizer")) {
      throw new ForbiddenException(
        "You do not have permission to manage roster images",
      );
    }

    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        roster_image_url: true,
      },
    });

    if (!players_by_pk) {
      throw new ForbiddenException("Player not found");
    }

    const replaced = await this.replacePlayerRosterImagePointer(steamId, null);
    await this.removeUnreferencedRosterImage(replaced);

    this.logger.log(`Removed player ${steamId} roster image`);
  }

  async uploadTeamRosterPlayerImage(
    teamId: string,
    steamId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    await this.assertTeamRosterEditor(teamId, user);

    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
            player_steam_id: { _eq: steamId },
          },
          limit: 1,
        },
        roster_image_url: true,
      },
    });

    const existing = team_roster?.[0];
    if (!existing) {
      throw new ForbiddenException("Player is not on this team's roster");
    }

    const path = this.buildTeamRosterPath(teamId, steamId, mimetype);

    await this.s3.put(path, buffer);

    let replaced: ReplacedRosterImage;
    try {
      replaced = await this.replaceTeamRosterImagePointer(teamId, steamId, path);
    } catch (error) {
      await this.s3.remove(path);
      throw error;
    }
    await this.removeUnreferencedRosterImage(replaced);

    this.logger.log(
      `Uploaded team ${teamId} roster image for player ${steamId} to ${path}`,
    );
    return path;
  }

  async removeTeamRosterPlayerImage(
    teamId: string,
    steamId: string,
    user: User,
  ): Promise<void> {
    await this.assertTeamRosterEditor(teamId, user);

    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
            player_steam_id: { _eq: steamId },
          },
          limit: 1,
        },
        roster_image_url: true,
      },
    });

    const existing = team_roster?.[0];
    if (!existing) {
      throw new ForbiddenException("Player is not on this team's roster");
    }

    const replaced = await this.replaceTeamRosterImagePointer(
      teamId,
      steamId,
      null,
    );
    await this.removeUnreferencedRosterImage(replaced);

    this.logger.log(
      `Removed team ${teamId} roster image for player ${steamId}`,
    );
  }

  private async replacePlayerRosterImagePointer(
    steamId: string,
    newPath: string | null,
  ): Promise<ReplacedRosterImage> {
    return this.postgres.transaction(async (client) => {
      const existing = await client.query<{ roster_image_url: string | null }>(
        `SELECT roster_image_url
           FROM public.players
          WHERE steam_id = $1
          FOR UPDATE`,
        [steamId],
      );
      if (existing.rows.length === 0) {
        throw new Error("Player not found");
      }

      const oldPath = existing.rows[0].roster_image_url;
      await client.query(
        `UPDATE public.players
            SET roster_image_url = $2
          WHERE steam_id = $1`,
        [steamId, newPath],
      );

      return {
        oldPath,
        newPath,
        referenced: oldPath
          ? await this.rosterImageIsReferenced(client, oldPath)
          : false,
      };
    });
  }

  private async replaceTeamRosterImagePointer(
    teamId: string,
    steamId: string,
    newPath: string | null,
  ): Promise<ReplacedRosterImage> {
    return this.postgres.transaction(async (client) => {
      const existing = await client.query<{ roster_image_url: string | null }>(
        `SELECT roster_image_url
           FROM public.team_roster
          WHERE team_id = $1
            AND player_steam_id = $2
          FOR UPDATE`,
        [teamId, steamId],
      );
      if (existing.rows.length === 0) {
        throw new Error("Player is not on this team's roster");
      }

      const oldPath = existing.rows[0].roster_image_url;
      await client.query(
        `UPDATE public.team_roster
            SET roster_image_url = $3
          WHERE team_id = $1
            AND player_steam_id = $2`,
        [teamId, steamId, newPath],
      );

      return {
        oldPath,
        newPath,
        referenced: oldPath
          ? await this.rosterImageIsReferenced(client, oldPath)
          : false,
      };
    });
  }

  private async rosterImageIsReferenced(
    client: PoolClient,
    path: string,
  ): Promise<boolean> {
    const result = await client.query<{ referenced: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM public.tournament_team_roster
          WHERE roster_image_url_snapshot = $1
       ) OR EXISTS (
         SELECT 1
           FROM public.match_lineup_players
          WHERE roster_image_url_snapshot = $1
       ) AS referenced`,
      [path],
    );
    return result.rows[0]?.referenced === true;
  }

  private async removeUnreferencedRosterImage(
    replaced: ReplacedRosterImage,
  ): Promise<void> {
    if (
      replaced.oldPath &&
      replaced.oldPath !== replaced.newPath &&
      !replaced.referenced
    ) {
      await this.s3.remove(replaced.oldPath);
    }
  }

  async uploadTournamentLogo(
    tournamentId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { logo } = await this.assertTournamentOrganizer(tournamentId, user);

    const path = this.buildPath("tournaments", tournamentId, mimetype);

    await this.s3.put(path, buffer);

    if (logo && logo !== path) {
      await this.s3.remove(logo);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { logo: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded tournament ${tournamentId} logo to ${path}`);
    return path;
  }

  async removeTournamentLogo(tournamentId: string, user: User): Promise<void> {
    const { logo } = await this.assertTournamentOrganizer(tournamentId, user);

    if (logo) {
      await this.s3.remove(logo);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { logo: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed tournament ${tournamentId} logo`);
  }

  async uploadTournamentBanner(
    tournamentId: string,
    user: User,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { banner } = await this.assertTournamentOrganizer(tournamentId, user);

    const path = this.buildPath("tournaments", tournamentId, mimetype);

    await this.s3.put(path, buffer);

    if (banner && banner !== path) {
      await this.s3.remove(banner);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { banner: path },
        },
        __typename: true,
      },
    });

    this.logger.log(`Uploaded tournament ${tournamentId} banner to ${path}`);
    return path;
  }

  async removeTournamentBanner(
    tournamentId: string,
    user: User,
  ): Promise<void> {
    const { banner } = await this.assertTournamentOrganizer(tournamentId, user);

    if (banner) {
      await this.s3.remove(banner);
    }

    await this.hasura.mutation({
      update_tournaments_by_pk: {
        __args: {
          pk_columns: { id: tournamentId },
          _set: { banner: null },
        },
        __typename: true,
      },
    });

    this.logger.log(`Removed tournament ${tournamentId} banner`);
  }

  // Returns the existing logo/banner paths when the caller may manage the tournament.
  private async assertTournamentOrganizer(
    tournamentId: string,
    user: User,
  ): Promise<{
    logo: string | null | undefined;
    banner: string | null | undefined;
  }> {
    const { tournaments_by_pk } = await this.hasura.query({
      tournaments_by_pk: {
        __args: { id: tournamentId },
        logo: true,
        banner: true,
        organizer_steam_id: true,
        organizers: {
          __args: {
            where: { steam_id: { _eq: user.steam_id } },
            limit: 1,
          },
          steam_id: true,
        },
      },
    });

    if (!tournaments_by_pk) {
      throw new ForbiddenException("Tournament not found");
    }

    const isOrganizer =
      user.role === "administrator" ||
      tournaments_by_pk.organizer_steam_id === user.steam_id ||
      (tournaments_by_pk.organizers?.length ?? 0) > 0;

    if (!isOrganizer) {
      throw new ForbiddenException("You do not organize this tournament");
    }

    return { logo: tournaments_by_pk.logo, banner: tournaments_by_pk.banner };
  }

  async getStream(
    kind: AvatarKind,
    filename: string,
  ): Promise<{ stream: Readable; contentType: string; etag?: string } | null> {
    const key = `avatars/${kind}/${filename}`;

    if (!(await this.s3.has(key))) {
      return null;
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

  private buildPath(kind: AvatarKind, id: string, mimetype: string): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `avatars/${kind}/${id}-${hash}.${ext}`;
  }

  private buildTeamRosterPath(
    teamId: string,
    steamId: string,
    mimetype: string,
  ): string {
    const ext = EXTENSION_BY_MIMETYPE[mimetype] || "png";
    const hash = crypto.randomBytes(6).toString("hex");
    return `avatars/roster-teams/${teamId}-${steamId}-${hash}.${ext}`;
  }

  private async assertTeamRosterEditor(
    teamId: string,
    user: User,
  ): Promise<void> {
    if (!isRoleAbove(user.role, "tournament_organizer")) {
      throw new ForbiddenException(
        "You do not have permission to manage this team's roster images",
      );
    }

    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        id: true,
      },
    });

    if (!teams_by_pk) {
      throw new ForbiddenException("Team not found");
    }
  }

  private guessContentType(filename: string): string {
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg"))
      return "image/jpeg";
    if (filename.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }
}
