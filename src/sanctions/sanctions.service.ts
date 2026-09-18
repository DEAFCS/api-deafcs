import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { PostgresService } from "src/postgres/postgres.service";
import { RconService } from "src/rcon/rcon.service";
import { DedicatedServersService } from "src/dedicated-servers/dedicated-servers.service";
import { SYSTEM_STEAM_ID } from "src/matches/disconnect-budget/constants";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";

export type SanctionType =
  | "ban"
  | "mute"
  | "gag"
  | "silence"
  | "website_chat_mute";

export type WebsiteChatMuteStatus = {
  active: boolean;
  expiresAt: string | null;
  permanent: boolean;
};

@Injectable()
export class SanctionsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly rconService: RconService,
    private readonly dedicatedServersService: DedicatedServersService,
    private readonly redisManager: RedisManagerService,
  ) {}

  private static readonly SANCTION_TYPES: SanctionType[] = [
    "ban",
    "mute",
    "gag",
    "silence",
    "website_chat_mute",
  ];

  public async getWebsiteChatMuteStatus(
    steamId: string,
  ): Promise<WebsiteChatMuteStatus> {
    const rows = await this.postgres.query<
      Array<{ remove_sanction_date: string | null }>
    >(
      `SELECT remove_sanction_date
         FROM public.player_sanctions
        WHERE player_steam_id = $1::bigint
          AND type = 'website_chat_mute'
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
        ORDER BY created_at DESC
        LIMIT 1`,
      [steamId],
    );

    const sanction = rows[0];
    return {
      active: Boolean(sanction),
      expiresAt: sanction?.remove_sanction_date
        ? new Date(sanction.remove_sanction_date).toISOString()
        : null,
      permanent: Boolean(sanction && !sanction.remove_sanction_date),
    };
  }

  public async getActiveServerSanctions(serverId: string): Promise<
    Array<{
      steam_id: string;
      is_banned: boolean;
      is_muted: boolean;
      is_gagged: boolean;
    }>
  > {
    const player_sanctions = await this.postgres.query<
      Array<{ player_steam_id: string; type: string }>
    >(
      `SELECT player_steam_id::text AS player_steam_id, type
         FROM public.player_sanctions
        WHERE deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())`,
    );

    const byPlayer: Record<
      string,
      { steam_id: string; is_banned: boolean; is_muted: boolean; is_gagged: boolean }
    > = {};

    for (const sanction of player_sanctions) {
      const steamId = `${sanction.player_steam_id}`;
      const entry = (byPlayer[steamId] = byPlayer[steamId] || {
        steam_id: steamId,
        is_banned: false,
        is_muted: false,
        is_gagged: false,
      });

      if (sanction.type === "ban") {
        entry.is_banned = true;
      } else if (sanction.type === "mute") {
        entry.is_muted = true;
      } else if (sanction.type === "gag") {
        entry.is_gagged = true;
      } else if (sanction.type === "silence") {
        entry.is_muted = true;
        entry.is_gagged = true;
      }
    }

    return Object.values(byPlayer);
  }

  public async sanctionServerPlayer(params: {
    serverId?: string | null;
    steamId: string;
    type: SanctionType;
    reason?: string | null;
    duration?: number | null;
    sanctionedBySteamId: string;
    evidenceMessageId?: string | null;
  }): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const {
      serverId,
      steamId,
      type,
      reason,
      duration,
      sanctionedBySteamId,
      evidenceMessageId,
    } = params;

    if (!SanctionsService.SANCTION_TYPES.includes(type)) {
      throw Error(`invalid sanction type ${type}`);
    }

    if (type === "website_chat_mute") {
      const trimmedReason = reason?.trim();
      if (!trimmedReason) {
        throw Error("a reason is required for a website chat mute");
      }

      if (duration != null && (!Number.isFinite(duration) || duration < 0)) {
        throw Error("invalid website chat mute duration");
      }

      // A website mute never inspects or syncs a game server, even if a
      // crafted action request supplies serverId.
      await this.ensurePlayer(steamId);
      const rows = await this.postgres.query<
        Array<{ id: string; remove_sanction_date: string | null }>
      >(
        `INSERT INTO public.player_sanctions (
           type,
           player_steam_id,
           sanctioned_by_steam_id,
           reason,
           remove_sanction_date,
           evidence_message_id
         ) VALUES (
           'website_chat_mute',
           $1::bigint,
           $2::bigint,
           $3,
           CASE
             WHEN $4::double precision > 0
               THEN now() + ($4::double precision * interval '1 millisecond')
             ELSE NULL
           END,
           $5
         )
         RETURNING id, remove_sanction_date`,
        [
          steamId,
          sanctionedBySteamId,
          trimmedReason,
          duration ?? 0,
          evidenceMessageId ?? null,
        ],
      );

      const status: WebsiteChatMuteStatus = {
        active: true,
        expiresAt: rows[0]?.remove_sanction_date
          ? new Date(rows[0].remove_sanction_date).toISOString()
          : null,
        permanent: !rows[0]?.remove_sanction_date,
      };
      await this.publishWebsiteChatMuteStatus(steamId, status);

      return {
        id: rows[0]?.id ?? null,
        enforced: true,
        message: "website chat mute saved and enforced",
      };
    }

    let onServer:
      | { steam_id: string; name: string; userid: string | null }
      | undefined;

    if (serverId) {
      const roster =
        await this.dedicatedServersService.getServerPlayerList(serverId);
      onServer = roster.find((player) => player.steam_id === steamId);
    }

    await this.ensurePlayer(steamId, onServer?.name);

    let removeSanctionDate: string | null = null;
    if (duration && duration > 0) {
      removeSanctionDate = new Date(Date.now() + duration).toISOString();
    }

    const { insert_player_sanctions_one } = await this.hasura.mutation({
      insert_player_sanctions_one: {
        __args: {
          object: {
            type,
            player_steam_id: steamId,
            sanctioned_by_steam_id: sanctionedBySteamId,
            reason: reason ?? null,
            remove_sanction_date: removeSanctionDate,
          },
        },
        id: true,
      },
    });

    let enforced = false;
    let message = "sanction saved";

    if (serverId) {
      const result = await this.syncServer(
        serverId,
        type === "ban" ? (onServer?.userid ?? null) : null,
      );
      enforced = result.enforced;
      message = result.message;
    }

    return {
      id: insert_player_sanctions_one?.id ?? null,
      enforced,
      message,
    };
  }

  public async unsanctionServerPlayer(params: {
    serverId?: string | null;
    steamId: string;
    type: SanctionType;
    revokedBySteamId: string;
  }): Promise<{ id: string | null; enforced: boolean; message: string }> {
    const { serverId, steamId, type, revokedBySteamId } = params;

    if (!SanctionsService.SANCTION_TYPES.includes(type)) {
      throw Error(`invalid sanction type ${type}`);
    }

    if (type === "website_chat_mute") {
      const rows = await this.postgres.query<Array<{ id: string }>>(
        `UPDATE public.player_sanctions
            SET deleted_at = now(), revoked_by_steam_id = $3::bigint
          WHERE player_steam_id = $1::bigint
            AND type = $2
            AND deleted_at IS NULL
            AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
          RETURNING id`,
        [steamId, type, revokedBySteamId],
      );

      if (rows.length > 0) {
        await this.publishWebsiteChatMuteStatus(steamId, {
          active: false,
          expiresAt: null,
          permanent: false,
        });
      }

      return {
        id: rows[0]?.id ?? null,
        enforced: rows.length > 0,
        message:
          rows.length > 0
            ? "website chat mute removed"
            : "no active website chat mute found",
      };
    }

    await this.postgres.query(
      `UPDATE public.player_sanctions
          SET deleted_at = now(), revoked_by_steam_id = $3::bigint
        WHERE player_steam_id = $1::bigint
          AND type = $2
          AND deleted_at IS NULL`,
      [steamId, type, revokedBySteamId],
    );

    let enforced = false;
    let message = "sanction removed";

    if (serverId) {
      const result = await this.syncServer(serverId, null);
      enforced = result.enforced;
      message = result.message;
    }

    return {
      id: null,
      enforced,
      message,
    };
  }

  private async publishWebsiteChatMuteStatus(
    steamId: string,
    status: WebsiteChatMuteStatus,
  ) {
    await this.redisManager.getConnection().publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId,
        event: "chat:mute-status",
        data: status,
      }),
    );
  }

  // Plain delete_abandoned_matches_by_pk only removed the history row --
  // it never touched the actual enforcement (player_sanctions) or
  // leaver_ban_stage (see DisconnectBudgetService.applyLeaverBan), so an
  // admin clearing out a mistaken/unfair automated ban was left thinking
  // it was undone while the player stayed banned and kept escalating
  // further on their next violation regardless. This does all three in
  // one action: removes the record, lifts the still-active system-issued
  // ban for that violation (if any), and undoes one step of escalation.
  //
  // Deliberately a flat -1, not a reset to 0 -- e.g. stage 1,2,3,4,4+ (the
  // last one capped, not a real extra escalation): removing the "4+" entry
  // should land back on stage 4 (what match 4 legitimately earned), not
  // wipe out real history by zeroing everything out. This is a
  // close-enough approximation of that when the stage is at the cap
  // (removing the capped entry looks the same as removing the one before
  // it) -- getting it exactly right in every case would mean tracking each
  // violation's prior stage individually, which isn't worth the added
  // complexity for how rarely this runs.
  public async removeAbandonedMatch(id: string): Promise<void> {
    const [removed] = await this.postgres.query<
      Array<{ steam_id: string }>
    >(
      `DELETE FROM public.abandoned_matches
        WHERE id = $1
       RETURNING steam_id`,
      [id],
    );

    if (!removed) {
      return;
    }

    const { steam_id: steamId } = removed;

    await this.postgres.query(
      `UPDATE public.player_sanctions
          SET deleted_at = now()
        WHERE player_steam_id = $1::bigint
          AND type = 'ban'
          AND sanctioned_by_steam_id = $2::bigint
          AND deleted_at IS NULL`,
      [steamId, SYSTEM_STEAM_ID],
    );

    const [player] = await this.postgres.query<
      Array<{ leaver_ban_stage: number }>
    >(
      `UPDATE public.players
          SET leaver_ban_stage = GREATEST(leaver_ban_stage - 1, 0)
        WHERE steam_id = $1::bigint
        RETURNING leaver_ban_stage`,
      [steamId],
    );

    if (player?.leaver_ban_stage === 0) {
      await this.postgres.query(
        `UPDATE public.players
            SET leaver_ban_stage_expires_at = NULL
          WHERE steam_id = $1::bigint`,
        [steamId],
      );
    }
  }

  public async kickServerPlayer(params: {
    serverId: string;
    steamId: string;
    reason?: string | null;
  }): Promise<{ kicked: boolean; message: string }> {
    const { serverId, steamId, reason } = params;

    const userid = await this.dedicatedServersService.resolveServerUserId(
      serverId,
      steamId,
    );

    if (!userid) {
      return { kicked: false, message: "player is not on the server" };
    }

    const message = (reason || "Kicked")
      .replace(/[\r\n";]/g, " ")
      .trim()
      .slice(0, 120);

    try {
      const rcon = await this.rconService.connect(serverId);
      if (!rcon) {
        return { kicked: false, message: "unable to connect to server rcon" };
      }

      await rcon.send(`kickid ${userid} ${message}`);

      return { kicked: true, message: "player kicked" };
    } catch (error) {
      this.logger.warn(`failed to kick ${steamId} on ${serverId}`, error);
      return { kicked: false, message: "failed to kick player" };
    } finally {
      await this.rconService.disconnect(serverId);
    }
  }

  private async ensurePlayer(steamId: string, name?: string): Promise<void> {
    await this.hasura.mutation({
      insert_players: {
        __args: {
          objects: [
            {
              steam_id: steamId,
              name: name || `Player ${steamId}`,
            },
          ],
          on_conflict: {
            constraint: "players_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }

  private async hasLiveMatch(serverId: string): Promise<boolean> {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            server_id: {
              _eq: serverId,
            },
            status: {
              _nin: ["Canceled", "Finished", "Forfeit", "Surrendered", "Tie"],
            },
          },
          limit: 1,
        },
        id: true,
      },
    });

    return matches.length > 0;
  }

  private async syncServer(
    serverId: string,
    kickUserid: string | null,
  ): Promise<{ enforced: boolean; message: string }> {
    try {
      const rcon = await this.rconService.connect(serverId);
      if (!rcon) {
        return {
          enforced: false,
          message: "sanction saved; unable to connect to server rcon",
        };
      }

      if (kickUserid) {
        await rcon.send(`kickid ${kickUserid} Banned`);
      }

      // The plugins carry mute/gag/ban as flags on the match payload, so a
      // match refresh is what actually re-applies them live. A server with no
      // match has no command to push sanctions to yet.
      if (!(await this.hasLiveMatch(serverId))) {
        return {
          enforced: kickUserid !== null,
          message: kickUserid
            ? "sanction saved and player kicked; server has no match to sync"
            : "sanction saved; server has no match to sync",
        };
      }

      await rcon.send("get_match");

      return {
        enforced: true,
        message: "sanction saved and synced to server",
      };
    } catch (error) {
      this.logger.warn(`failed to sync sanctions to ${serverId}`, error);
      return {
        enforced: false,
        message: "sanction saved; live enforcement failed",
      };
    } finally {
      await this.rconService.disconnect(serverId);
    }
  }
}
