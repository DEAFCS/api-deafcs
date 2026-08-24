import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";

// Same active-match-statuses gate as CameraService's token validation --
// a token is only meaningful while the match is actually being played
// or about to be.
const STREAMER_CAMERA_ACTIVE_MATCH_STATUSES = new Set([
  "Veto",
  "Live",
  "WaitingForServer",
]);

export type StreamerCameraTokenLookup = {
  matchId: string;
  steamId: string;
};

// Deliberately separate from CameraService (../camera/camera.service.ts).
// That service is the admin-only anti-cheat webcam check: an admin views
// a player's feed, nobody else ever sees it. This service is the
// opposite in every way that matters -- a player opts in to publish
// their camera into the *public* stream, gated by its own
// streamer_camera_enabled column, using its own path prefix so a match
// can run both features at once without either one touching the other's
// MediaMTX paths, tokens, or permission checks. See deafcs-web issue #91.
//
// Points at the MAIN mediamtx (same one match video/audio already
// streams through via SRT), not the separate mediamtx-camera instance
// CameraService uses -- deliberately its own env vars, not shared with
// CameraService's MEDIAMTX_CAMERA_*, so this can point somewhere
// completely different without affecting that feature at all. Live
// debugging traced a persistent WebRTC ICE/DTLS failure ("deadline
// exceeded while waiting connection") specifically between a
// hostNetwork game-streamer pod and mediamtx-camera, that a TURN relay
// didn't fix either -- meanwhile the exact same kind of cross-node
// WebRTC consumption against the MAIN mediamtx is already proven
// working in production (real viewers watch matches through it). This
// matches upstream 5stackgg's own architecture too: they don't run a
// separate mediamtx-camera at all, everything (SRT + WHIP/WHEP) goes
// through one mediamtx instance -- DEAFCS's mediamtx-camera split is
// fork-specific, added later for the camera_required feature only.

@Injectable()
export class StreamerCameraService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    // Reverted after live testing (see git history): routing through
    // the main mediamtx did NOT fix the underlying connection failure
    // either -- proving the problem was never server-side (mediamtx vs
    // mediamtx-camera) to begin with. Kept on the dedicated instance so
    // this doesn't compete with actual match video/audio for
    // resources, since that separation was correct regardless.
    this.mediaMtxHost = process.env.STREAMER_MEDIAMTX_HOST || "mediamtx-camera";
    this.whipPort = process.env.STREAMER_MEDIAMTX_WHIP_PORT || "8891";
    this.apiPort = process.env.STREAMER_MEDIAMTX_API_PORT || "9998";
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

  // --- Player-facing: gated only by the secret token, no session ---
  // Mirrors CameraService.validateToken exactly (same shape, same
  // active-match-status gate) -- reached either by the player's own
  // match page (popup on the same device) or a phone that scanned a QR
  // code, neither of which necessarily carries a Hasura user JWT, so
  // this deliberately doesn't require one, same reasoning as the
  // require-camera flow.

  public async validateToken(
    token: string,
  ): Promise<StreamerCameraTokenLookup | null> {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;

    let match_streamer_camera_tokens: Array<{
      match_id: unknown;
      steam_id: unknown;
      match?: { status?: unknown } | null;
    }>;
    try {
      ({ match_streamer_camera_tokens } = await this.hasura.query({
        match_streamer_camera_tokens: {
          __args: {
            where: { token: { _eq: token } },
            limit: 1,
          },
          match_id: true,
          steam_id: true,
          match: {
            status: true,
          },
        },
      }));
    } catch (error) {
      this.logger.warn(
        `[streamer-camera] token lookup failed: ${(error as Error)?.message}`,
      );
      return null;
    }

    const row = match_streamer_camera_tokens?.[0];
    if (!row) return null;

    const status = row.match?.status as string | undefined;
    if (!status || !STREAMER_CAMERA_ACTIVE_MATCH_STATUSES.has(status)) {
      return null;
    }

    return { matchId: row.match_id as string, steamId: row.steam_id as string };
  }

  public async proxyPlayerWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) {
      throw new Error("invalid or expired camera link");
    }
    if (!(await this.isEnabledForMatch(lookup.matchId))) {
      throw new Error("streamer camera is not enabled for this match");
    }
    const path = StreamerCameraService.pathForPlayer(
      lookup.matchId,
      lookup.steamId,
    );
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ enabled: boolean; ready: boolean }> {
    const lookup = await this.validateToken(token);
    if (!lookup) {
      return { enabled: false, ready: false };
    }
    const enabled = await this.isEnabledForMatch(lookup.matchId);
    if (!enabled) {
      return { enabled: false, ready: false };
    }
    const path = StreamerCameraService.pathForPlayer(
      lookup.matchId,
      lookup.steamId,
    );
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
