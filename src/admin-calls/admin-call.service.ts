import { Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";

// General-purpose admin<->player webcam call, reachable from the
// camera icon on every player profile page -- for anything an admin
// wants to say or ask a specific player, not tied to any application
// or match. Structurally identical to VerificationCallService (same
// WHIP/WHEP mechanics, same "ring one specific player directly"
// pattern via send-message-to-steam-id instead of a chat-room
// broadcast), just keyed by the target player's own steamId instead
// of an application id.
export type AdminCallParticipant = {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
};

type PlayerRow = { steam_id: string };

@Injectable()
export class AdminCallService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.mediaMtxHost = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
    this.whipPort = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
    this.apiPort = process.env.MEDIAMTX_CAMERA_API_PORT || "9998";
    this.redis = this.redisManager.getConnection();
  }

  public static pathFor(targetSteamId: string, steamId: string): string {
    return `admin-call-${targetSteamId}-${steamId}`;
  }

  private async getPlayer(targetSteamId: string): Promise<PlayerRow> {
    const rows = await this.postgres.query<PlayerRow[]>(
      `SELECT steam_id::text AS steam_id FROM public.players WHERE steam_id = $1`,
      [targetSteamId],
    );
    if (!rows[0]) {
      throw new Error("player not found");
    }
    return rows[0];
  }

  // Either an administrator, or the one player this call actually
  // targets -- nobody else has any business on this call.
  private async assertParticipant(
    targetSteamId: string,
    user: User,
  ): Promise<PlayerRow> {
    const player = await this.getPlayer(targetSteamId);
    if (isRoleAbove(user.role, "administrator")) {
      return player;
    }
    if (String(user.steam_id) === player.steam_id) {
      return player;
    }
    throw new Error("not authorized for this call");
  }

  // Which admin is currently ringing a given target -- kept just long
  // enough for the player to actually answer (see ring/respondToRing
  // below), so the answer can be routed back to that specific admin's
  // own popup instead of leaving it silently guessing.
  private static ringingKey(targetSteamId: string): string {
    return `admin-call-ringing:${targetSteamId}`;
  }
  private static readonly RINGING_TTL_SECONDS = 60;

  // Admin rings the player -- a full-screen "Admin is calling..."
  // overlay on whatever page the player is currently on (see
  // GlobalAdminCallNotifier.vue), not itself part of the WebRTC
  // signaling. The admin's own call page now waits on this ring instead
  // of jumping straight to the device picker (see respondToRing below).
  public async ring(targetSteamId: string, user: User): Promise<void> {
    if (!isRoleAbove(user.role, "administrator")) {
      throw new Error("admin only");
    }
    const player = await this.getPlayer(targetSteamId);

    await this.redis.set(
      AdminCallService.ringingKey(targetSteamId),
      JSON.stringify({ adminSteamId: String(user.steam_id) }),
      "EX",
      AdminCallService.RINGING_TTL_SECONDS,
    );

    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId: player.steam_id,
        event: "admin-call:ring",
        data: {
          targetSteamId,
          adminName: user.name ?? null,
          adminAvatarUrl: user.avatar_url ?? null,
        },
      }),
    );

    // Safety net for the admin's own "Calling..." screen: it previously
    // relied entirely on the player's browser running its own 60s
    // auto-decline timer and calling respondToRing, so if that tab was
    // closed or never loaded, the admin waited forever with no answer.
    // This fires independently of the player's client and reaches the
    // same result whenever nobody has actually responded by then.
    setTimeout(() => {
      void this.timeoutRingIfUnanswered(targetSteamId);
    }, AdminCallService.RINGING_TTL_SECONDS * 1000);
  }

  private async timeoutRingIfUnanswered(targetSteamId: string): Promise<void> {
    const key = AdminCallService.ringingKey(targetSteamId);
    const raw = await this.redis.get(key);
    if (!raw) {
      // Already answered (or the key expired/was cleared some other way).
      return;
    }
    const { adminSteamId } = JSON.parse(raw) as { adminSteamId: string };
    await this.redis.del(key);
    await this.notifyRingResolved(targetSteamId, adminSteamId, {
      accepted: false,
      playerName: null,
      timedOut: true,
    });
  }

  private async notifyRingResolved(
    targetSteamId: string,
    adminSteamId: string,
    data: { accepted: boolean; playerName: string | null; timedOut?: boolean },
  ): Promise<void> {
    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId: adminSteamId,
        event: "admin-call:response",
        data: { targetSteamId, ...data },
      }),
    );
  }

  // The player answering the ring above -- routes the accept/decline
  // back to whichever admin is actually waiting on it, same "fail
  // quiet" convention as the rest of this service if the ring already
  // expired or nobody ever rang this target.
  public async respondToRing(
    targetSteamId: string,
    user: User,
    accepted: boolean,
  ): Promise<void> {
    if (String(user.steam_id) !== targetSteamId) {
      throw new Error("not authorized to respond to this call");
    }

    const raw = await this.redis.get(
      AdminCallService.ringingKey(targetSteamId),
    );
    if (!raw) {
      return;
    }
    const { adminSteamId } = JSON.parse(raw) as { adminSteamId: string };

    // One answer per ring, whichever way it goes -- clears the slot so
    // a stray retry (or the timeout above) can't re-deliver a second
    // response for the same ring.
    await this.redis.del(AdminCallService.ringingKey(targetSteamId));

    await this.notifyRingResolved(targetSteamId, adminSteamId, {
      accepted,
      playerName: user.name ?? null,
    });
  }

  public async join(
    targetSteamId: string,
    user: User,
  ): Promise<{ token: string; participants: AdminCallParticipant[] }> {
    await this.assertParticipant(targetSteamId, user);

    const rows = await this.postgres.query<Array<{ token: string }>>(
      `INSERT INTO public.admin_call_tokens (target_steam_id, steam_id)
       VALUES ($1, $2)
       ON CONFLICT (target_steam_id, steam_id)
         DO UPDATE SET target_steam_id = EXCLUDED.target_steam_id
       RETURNING token`,
      [targetSteamId, user.steam_id],
    );

    const participants = await this.getParticipants(
      targetSteamId,
      String(user.steam_id),
    );

    return { token: rows[0].token, participants };
  }

  public async validateToken(
    token: string,
  ): Promise<{ targetSteamId: string; steamId: string } | null> {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;

    const rows = await this.postgres.query<
      Array<{ target_steam_id: string; steam_id: string }>
    >(
      `SELECT target_steam_id::text AS target_steam_id, steam_id::text AS steam_id
         FROM public.admin_call_tokens WHERE token = $1`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;

    return { targetSteamId: row.target_steam_id, steamId: row.steam_id };
  }

  public async proxyWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired call link");

    const path = AdminCallService.pathFor(lookup.targetSteamId, lookup.steamId);
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ ready: boolean; steamId?: string }> {
    const lookup = await this.validateToken(token);
    if (!lookup) return { ready: false };
    const status = await this.getPathStatus(
      AdminCallService.pathFor(lookup.targetSteamId, lookup.steamId),
    );
    return { ...status, steamId: lookup.steamId };
  }

  public async hangupForToken(token: string): Promise<void> {
    const lookup = await this.validateToken(token);
    if (!lookup) return;
    await this.kickPath(
      AdminCallService.pathFor(lookup.targetSteamId, lookup.steamId),
    );
  }

  public async proxyPeerWhep(
    targetSteamId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertParticipant(targetSteamId, user);
    const path = AdminCallService.pathFor(targetSteamId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  public async proxyPeerWhepForToken(
    token: string,
    steamId: string,
    sdp: string,
  ): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired call link");
    const path = AdminCallService.pathFor(lookup.targetSteamId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  // Active participants right now, resolved by asking mediamtx which
  // admin-call-{targetSteamId}-* paths are actually publishing -- same
  // as VerificationCallService, always at most the admin plus the
  // target player, never more.
  public async getParticipants(
    targetSteamId: string,
    excludeSteamId?: string,
  ): Promise<AdminCallParticipant[]> {
    const prefix = `admin-call-${targetSteamId}-`;
    let steamIds: string[] = [];
    try {
      const res = await fetch(
        `http://${this.mediaMtxHost}:${this.apiPort}/v3/paths/list`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{ name: string; ready?: boolean }>;
        };
        steamIds = (data.items ?? [])
          .filter((p) => p.ready && p.name.startsWith(prefix))
          .map((p) => p.name.slice(prefix.length))
          .filter((id) => id !== excludeSteamId);
      }
    } catch (error) {
      this.logger.warn(
        `[admin-call] failed to list active paths: ${(error as Error)?.message}`,
      );
    }

    if (!steamIds.length) return [];

    const { players } = await this.hasura.query({
      players: {
        __args: { where: { steam_id: { _in: steamIds } } },
        steam_id: true,
        name: true,
        avatar_url: true,
        custom_avatar_url: true,
      },
    });

    return (players ?? []).map((p) => ({
      steamId: String(p.steam_id),
      name: p.name ?? null,
      avatarUrl: (p.custom_avatar_url || p.avatar_url) ?? null,
    }));
  }

  public async getParticipantsForUser(
    targetSteamId: string,
    user: User,
  ): Promise<AdminCallParticipant[]> {
    await this.assertParticipant(targetSteamId, user);
    return this.getParticipants(targetSteamId, String(user.steam_id));
  }

  public async getParticipantsForToken(
    token: string,
  ): Promise<AdminCallParticipant[]> {
    const lookup = await this.validateToken(token);
    if (!lookup) return [];
    return this.getParticipants(lookup.targetSteamId, lookup.steamId);
  }

  private async proxySdp(targetPath: string, sdp: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(
        `http://${this.mediaMtxHost}:${this.whipPort}${targetPath}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: sdp,
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      this.logger.error(
        `[admin-call] proxy to mediamtx-camera failed (${targetPath}): ${(error as Error)?.message}`,
      );
      throw new Error("camera signaling service unreachable");
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `mediamtx-camera ${targetPath} -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return text;
  }

  private async getPathStatus(path: string): Promise<{ ready: boolean }> {
    try {
      const res = await fetch(
        `http://${this.mediaMtxHost}:${this.apiPort}/v3/paths/get/${path}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return { ready: false };
      const json = (await res.json()) as { ready?: boolean };
      return { ready: json.ready === true };
    } catch {
      return { ready: false };
    }
  }

  private async kickPath(path: string): Promise<void> {
    try {
      const res = await fetch(
        `http://${this.mediaMtxHost}:${this.apiPort}/v3/webrtcsessions/list`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        items?: Array<{ id: string; path?: string }>;
      };
      const matches = (data.items ?? []).filter((s) => s.path === path);
      await Promise.all(
        matches.map((s) =>
          fetch(
            `http://${this.mediaMtxHost}:${this.apiPort}/v3/webrtcsessions/kick/${s.id}`,
            { method: "POST", signal: AbortSignal.timeout(5_000) },
          ).catch(() => {}),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `[admin-call] kickPath(${path}) failed: ${(error as Error)?.message}`,
      );
    }
  }
}
