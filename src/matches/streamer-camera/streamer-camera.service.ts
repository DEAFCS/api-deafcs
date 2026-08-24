import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { User } from "../../auth/types/User";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";

// Deliberately separate from CameraService (../camera/camera.service.ts).
// That service is the admin-only anti-cheat webcam check: an admin views
// a player's feed, nobody else ever sees it. This service is the
// opposite in every way that matters -- a player opts in to publish
// their camera into the *public* stream, gated by its own
// streamer_camera_enabled column, using its own path prefix so a match
// can run both features at once without either one touching the other's
// MediaMTX paths, tokens, or permission checks. See deafcs-web issue #91.
//
// Reuses the same mediamtx-camera relay CameraService already talks to
// -- that's shared infrastructure (a WHIP/WHEP media server), not shared
// business logic -- just under a distinct path prefix ("stream-cam-"
// instead of "camera-") so the two features' streams can never collide.

@Injectable()
export class StreamerCameraService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    this.mediaMtxHost = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
    this.whipPort = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
    this.apiPort = process.env.MEDIAMTX_CAMERA_API_PORT || "9998";
  }

  public static pathForPlayer(matchId: string, steamId: string): string {
    return `stream-cam-${matchId}-${steamId}`;
  }

  private async isEnabledForMatch(matchId: string): Promise<boolean> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        options: {
          streamer_camera_enabled: true,
        },
      },
    });
    return match?.options?.streamer_camera_enabled === true;
  }

  private async isLineupPlayer(
    matchId: string,
    steamId: string,
  ): Promise<boolean> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        lineup_1: { lineup_players: { steam_id: true } },
        lineup_2: { lineup_players: { steam_id: true } },
      },
    });

    return [
      ...(match?.lineup_1?.lineup_players ?? []),
      ...(match?.lineup_2?.lineup_players ?? []),
    ].some((lineupPlayer) => String(lineupPlayer.steam_id) === String(steamId));
  }

  // --- Player-facing: publishes the logged-in player's own camera ---
  // No token system needed here (unlike CameraService) -- the player is
  // already on their own authenticated deafcs.net session when they opt
  // in from their match page, so their Hasura user is proof enough of
  // who they are. Always publishes as their own steam_id; there's no
  // path by which a player can publish for someone else.

  public async proxyPlayerWhip(
    matchId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    if (!(await this.isEnabledForMatch(matchId))) {
      throw new Error("streamer camera is not enabled for this match");
    }
    if (!(await this.isLineupPlayer(matchId, user.steam_id))) {
      throw new Error("player is not on either lineup for this match");
    }

    const path = StreamerCameraService.pathForPlayer(matchId, user.steam_id);
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async getPublishStatus(
    matchId: string,
    user: User,
  ): Promise<{ enabled: boolean; ready: boolean }> {
    const enabled = await this.isEnabledForMatch(matchId);
    if (!enabled) {
      return { enabled: false, ready: false };
    }
    const path = StreamerCameraService.pathForPlayer(matchId, user.steam_id);
    const { ready } = await this.getPathStatus(path);
    return { enabled, ready };
  }

  // --- Streamer-facing: game-streamer's HUD overlay pulls from here ---
  // Same x-origin-auth (`${matchId}:${match.password}`) scheme the rest
  // of the game-streamer <-> api boundary already uses (see
  // GameStreamerService.validateStatusOriginAuth) -- the overlay browser
  // window itself never holds real credentials, only game-streamer's
  // backend does, and it attaches this header when it proxies the HUD's
  // WHEP request through.

  public async validateBroadcastOriginAuth(
    matchId: string,
    originAuth: unknown,
  ): Promise<boolean> {
    if (!originAuth || typeof originAuth !== "string") {
      return false;
    }
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) {
      return false;
    }
    const headerMatchId = originAuth.substring(0, colonIndex);
    const apiPassword = originAuth.substring(colonIndex + 1);

    if (!timingSafeStringEqual(headerMatchId, matchId)) {
      return false;
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        password: true,
      },
    });

    if (!match?.password) {
      return false;
    }

    return timingSafeStringEqual(match.password, apiPassword);
  }

  public async proxyBroadcastWhep(
    matchId: string,
    steamId: string,
    sdp: string,
  ): Promise<string> {
    if (!(await this.isEnabledForMatch(matchId))) {
      throw new Error("streamer camera is not enabled for this match");
    }
    const path = StreamerCameraService.pathForPlayer(matchId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
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
        `[streamer-camera] proxy to mediamtx-camera failed (${targetPath}): ${(error as Error)?.message}`,
      );
      throw new Error("camera signaling service unreachable");
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`mediamtx-camera ${targetPath} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return text;
  }

  private async getPathStatus(path: string): Promise<{ ready: boolean }> {
    try {
      const res = await fetch(
        `http://${this.mediaMtxHost}:${this.apiPort}/v3/paths/get/${path}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (res.status === 404 || !res.ok) {
        return { ready: false };
      }
      const json = (await res.json()) as { ready?: boolean };
      return { ready: json.ready === true };
    } catch (error) {
      this.logger.warn(
        `[streamer-camera] status check failed for ${path}: ${(error as Error)?.message}`,
      );
      return { ready: false };
    }
  }
}
