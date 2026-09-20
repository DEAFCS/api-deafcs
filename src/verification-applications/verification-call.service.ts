import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type Redis from "ioredis";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { VerificationCallQueues } from "./enums/VerificationCallQueues";

// Admin <-> applicant webcam call for a verification application, for
// when an admin wants to ask something live before approving or
// rejecting (see DEAFCS verify feature). Reuses the exact same shape
// as LobbyCallService on purpose (WHIP publish on your own path, WHEP
// pull on the other person's) rather than inventing a new signaling
// model -- the only real difference is this is always exactly two
// fixed parties (whichever admin rang, and the one applicant), not an
// arbitrary lobby roster, and the "someone is calling" ping reaches
// one specific player directly (send-message-to-steam-id) instead of
// a lobby chat room broadcast.
export type VerificationCallParticipant = {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
};

type ApplicationRow = { id: string; player_steam_id: string };

@Injectable()
export class VerificationCallService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    @InjectQueue(VerificationCallQueues.RingTimeout)
    private readonly queue: Queue,
  ) {
    this.mediaMtxHost = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
    this.whipPort = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
    this.apiPort = process.env.MEDIAMTX_CAMERA_API_PORT || "9998";
    this.redis = this.redisManager.getConnection();
  }

  public static pathFor(applicationId: string, steamId: string): string {
    return `verify-call-${applicationId}-${steamId}`;
  }

  private async getApplication(applicationId: string): Promise<ApplicationRow> {
    const rows = await this.postgres.query<ApplicationRow[]>(
      `SELECT id, player_steam_id::text AS player_steam_id
         FROM public.verification_applications WHERE id = $1`,
      [applicationId],
    );
    if (!rows[0]) {
      throw new Error("verification application not found");
    }
    return rows[0];
  }

  // Either a moderator, or the one applicant this application
  // actually belongs to -- nobody else has any business on this call.
  private async assertParticipant(
    applicationId: string,
    user: User,
  ): Promise<ApplicationRow> {
    const application = await this.getApplication(applicationId);
    if (isRoleAbove(user.role, "moderator")) {
      return application;
    }
    if (String(user.steam_id) === application.player_steam_id) {
      return application;
    }
    throw new Error("not authorized for this verification call");
  }

  // Which staff member is currently ringing a given application -- kept just
  // long enough for the applicant to actually answer (see ring/respond
  // below), so the answer can be routed back to that specific admin's
  // own popup instead of leaving it silently guessing.
  private static ringingKey(applicationId: string): string {
    return `verify-call-ringing:${applicationId}`;
  }
  private static readonly RINGING_TTL_SECONDS = 60;

  // Moderator rings the applicant -- a full-screen staff call overlay
  // overlay on whatever page the applicant is currently on (see
  // GlobalVerificationCallNotifier.vue), not itself part of the WebRTC
  // signaling. The admin's own call page now waits on this ring instead
  // of jumping straight to the device picker (see respond below) --
  // previously it had no way to know whether the applicant had even
  // seen the popup, let alone answered it.
  public async ring(applicationId: string, user: User): Promise<void> {
    if (!isRoleAbove(user.role, "moderator")) {
      throw new Error("moderator only");
    }
    const application = await this.getApplication(applicationId);

    await this.redis.set(
      VerificationCallService.ringingKey(applicationId),
      JSON.stringify({ adminSteamId: String(user.steam_id) }),
      "EX",
      VerificationCallService.RINGING_TTL_SECONDS,
    );

    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId: application.player_steam_id,
        event: "verification-call:ring",
        data: {
          applicationId,
          adminName: user.name ?? null,
          adminAvatarUrl: user.avatar_url ?? null,
        },
      }),
    );

    // Safety net for the admin's own "Calling..." screen: it previously
    // relied entirely on the applicant's browser running its own 60s
    // auto-decline timer and calling respondToRing, so if that tab was
    // closed or never loaded, the admin waited forever with no answer.
    // A delayed BullMQ job (rather than a plain setTimeout) fires
    // independently of the applicant's client AND survives this API pod
    // restarting mid-ring, which an in-memory timer would silently lose.
    await this.queue.add(
      "TimeoutVerificationCallRing",
      { applicationId },
      {
        delay: VerificationCallService.RINGING_TTL_SECONDS * 1000,
        // BullMQ rejects a custom jobId containing ":" (reserved as its
        // own Redis key separator) -- this call itself would throw
        // "Custom Id cannot contain :" if left in.
        jobId: `verification-call-ring-timeout-${applicationId}`,
      },
    );
  }

  public async timeoutRingIfUnanswered(applicationId: string): Promise<void> {
    const key = VerificationCallService.ringingKey(applicationId);
    const raw = await this.redis.get(key);
    if (!raw) {
      // Already answered (or the key expired/was cleared some other way).
      return;
    }
    const { adminSteamId } = JSON.parse(raw) as { adminSteamId: string };
    await this.redis.del(key);
    await this.notifyRingResolved(applicationId, adminSteamId, {
      accepted: false,
      applicantName: null,
      timedOut: true,
    });
  }

  private async notifyRingResolved(
    applicationId: string,
    adminSteamId: string,
    data: {
      accepted: boolean;
      applicantName: string | null;
      timedOut?: boolean;
    },
  ): Promise<void> {
    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId: adminSteamId,
        event: "verification-call:response",
        data: { applicationId, ...data },
      }),
    );
  }

  // The applicant answering the ring above -- routes the accept/decline
  // back to whichever admin is actually waiting on it (not a broadcast,
  // since only that one admin's popup cares). Silently no-ops if the
  // ring already expired (admin gave up / popup closed) or nobody ever
  // rang this application, same "fail quiet" convention as everything
  // else here.
  public async respondToRing(
    applicationId: string,
    user: User,
    accepted: boolean,
  ): Promise<void> {
    const application = await this.getApplication(applicationId);
    if (String(user.steam_id) !== application.player_steam_id) {
      throw new Error("not authorized to respond to this call");
    }

    const raw = await this.redis.get(
      VerificationCallService.ringingKey(applicationId),
    );
    if (!raw) {
      return;
    }
    const { adminSteamId } = JSON.parse(raw) as { adminSteamId: string };

    // One answer per ring, whichever way it goes -- clears the slot so
    // a stray retry (or the timeout job below) can't re-deliver a
    // second response for the same ring.
    await this.redis.del(VerificationCallService.ringingKey(applicationId));
    await this.queue.remove(`verification-call-ring-timeout-${applicationId}`);

    await this.notifyRingResolved(applicationId, adminSteamId, {
      accepted,
      applicantName: user.name ?? null,
    });
  }

  // Mints (or reuses) a join token for the caller, matching the
  // required-webcam feature's QR/popup pattern exactly -- both the
  // phone-QR and the "this device" popup open the same token-gated
  // join page, no session round-trips needed once there.
  public async join(
    applicationId: string,
    user: User,
  ): Promise<{ token: string; participants: VerificationCallParticipant[] }> {
    await this.assertParticipant(applicationId, user);

    const rows = await this.postgres.query<Array<{ token: string }>>(
      `INSERT INTO public.verification_call_tokens (application_id, steam_id)
       VALUES ($1, $2)
       ON CONFLICT (application_id, steam_id)
         DO UPDATE SET application_id = EXCLUDED.application_id
       RETURNING token`,
      [applicationId, user.steam_id],
    );

    const participants = await this.getParticipants(
      applicationId,
      String(user.steam_id),
    );

    return { token: rows[0].token, participants };
  }

  public async validateToken(
    token: string,
  ): Promise<{ applicationId: string; steamId: string } | null> {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;

    const rows = await this.postgres.query<
      Array<{ application_id: string; steam_id: string }>
    >(
      `SELECT application_id, steam_id::text AS steam_id
         FROM public.verification_call_tokens WHERE token = $1`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;

    return { applicationId: row.application_id, steamId: row.steam_id };
  }

  public async proxyWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired call link");

    const path = VerificationCallService.pathFor(
      lookup.applicationId,
      lookup.steamId,
    );
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ ready: boolean; steamId?: string }> {
    const lookup = await this.validateToken(token);
    if (!lookup) return { ready: false };
    const status = await this.getPathStatus(
      VerificationCallService.pathFor(lookup.applicationId, lookup.steamId),
    );
    // The anonymous QR/phone join page has no session to know its own
    // steamId from -- it needs this to exclude its own tile when
    // pulling WHEP for the other side.
    return { ...status, steamId: lookup.steamId };
  }

  public async hangupForToken(token: string): Promise<void> {
    const lookup = await this.validateToken(token);
    if (!lookup) return;
    await this.kickPath(
      VerificationCallService.pathFor(lookup.applicationId, lookup.steamId),
    );
  }

  public async proxyPeerWhep(
    applicationId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertParticipant(applicationId, user);
    const path = VerificationCallService.pathFor(applicationId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  // Token-gated equivalent of proxyPeerWhep above -- for the anonymous
  // QR/phone join page, which has no session to resolve a User from.
  public async proxyPeerWhepForToken(
    token: string,
    steamId: string,
    sdp: string,
  ): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired call link");
    const path = VerificationCallService.pathFor(lookup.applicationId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  // Active participants right now, resolved by asking mediamtx which
  // verify-call-{applicationId}-* paths are actually publishing (not
  // tracked separately in our own DB -- mediamtx is already the source
  // of truth the rest of this feature relies on). This is always at
  // most the admin plus the applicant, never more.
  public async getParticipants(
    applicationId: string,
    excludeSteamId?: string,
  ): Promise<VerificationCallParticipant[]> {
    const prefix = `verify-call-${applicationId}-`;
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
        `[verification-call] failed to list active paths: ${(error as Error)?.message}`,
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
    applicationId: string,
    user: User,
  ): Promise<VerificationCallParticipant[]> {
    await this.assertParticipant(applicationId, user);
    return this.getParticipants(applicationId, String(user.steam_id));
  }

  public async getParticipantsForToken(
    token: string,
  ): Promise<VerificationCallParticipant[]> {
    const lookup = await this.validateToken(token);
    if (!lookup) return [];
    return this.getParticipants(lookup.applicationId, lookup.steamId);
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
        `[verification-call] proxy to mediamtx-camera failed (${targetPath}): ${(error as Error)?.message}`,
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
        `[verification-call] kickPath(${path}) failed: ${(error as Error)?.message}`,
      );
    }
  }
}
