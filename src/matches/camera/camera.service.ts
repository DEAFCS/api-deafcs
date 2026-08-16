import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { User } from "../../auth/types/User";
import { isRoleAbove } from "../../utilities/isRoleAbove";

// Camera tokens are only meaningful while the match is actually being
// played or about to be — the camera_required flow mints tokens on
// the veto->Live transition (see
// MatchesController.generateCameraTokensIfRequired), while an admin's
// on-demand spot check (CameraService.requestSpotCheck) can mint one
// as early as check-in, before the match has a lineup lock or a
// server. Either way, dead once the match leaves this set, so a
// leaked/old link stops working on its own without needing a separate
// expiry column.
const CAMERA_ACTIVE_MATCH_STATUSES = new Set([
  "WaitingForCheckIn",
  "Veto",
  "Live",
  "WaitingForServer",
]);

export type CameraTokenLookup = {
  matchId: string;
  steamId: string;
};

export type CameraPlayerStatus = {
  steamId: string;
  name: string | null;
  lineupId: string;
  ready: boolean;
  requested: boolean;
};

@Injectable()
export class CameraService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    this.mediaMtxHost = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
    this.whipPort = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
    this.apiPort = process.env.MEDIAMTX_CAMERA_API_PORT || "9998";
  }

  public static pathForPlayer(matchId: string, steamId: string): string {
    return `camera-${matchId}-${steamId}`;
  }

  // Separate path for admin's video-call ("talk") stream to a specific
  // player — kept distinct from the player's own required-camera path
  // above so a call starting/ending never touches that publish.
  public static talkPathForPlayer(matchId: string, steamId: string): string {
    return `camera-talk-${matchId}-${steamId}`;
  }

  // Every camera route is reached either by an anonymous phone/browser
  // holding nothing but the token, or by an admin's session — neither
  // carries a Hasura user JWT, so these reads intentionally go through
  // hasura.query() with no steamId (== the admin-secret client, same
  // pattern the rest of MatchesController uses for its own internal
  // reads) rather than trying to route around table-level permissions.
  public async validateToken(
    token: string,
  ): Promise<CameraTokenLookup | null> {
    // The token column is a Postgres `uuid` — anything not shaped like
    // one (a stray URL, a typo, someone probing the endpoint) would
    // otherwise reach Hasura and blow up as a 500 ("invalid input
    // syntax for type uuid") instead of a clean "not found". Reject it
    // here before it ever becomes a query.
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;

    let match_camera_tokens: Array<{
      match_id: unknown;
      steam_id: unknown;
      match?: { status?: unknown } | null;
    }>;
    try {
      ({ match_camera_tokens } = await this.hasura.query({
        match_camera_tokens: {
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
        `[camera] token lookup failed: ${(error as Error)?.message}`,
      );
      return null;
    }

    const row = match_camera_tokens?.[0];
    if (!row) return null;

    const status = row.match?.status as string | undefined;
    if (!status || !CAMERA_ACTIVE_MATCH_STATUSES.has(status)) {
      return null;
    }

    return { matchId: row.match_id as string, steamId: row.steam_id as string };
  }

  // Site-admins and this specific tournament's organizers only — not
  // the global "tournament_organizer" role, which would grant access
  // to every tournament rather than just this one. Mirrors the check
  // MatchActions.vue already applies to its other admin-only actions.
  public async assertCanWatch(matchId: string, user: User): Promise<void> {
    if (isRoleAbove(user.role, "administrator")) return;
    const isOrganizer = await this.matchAssistant.isOrganizer(matchId, user);
    if (!isOrganizer) {
      throw new Error("not authorized to view cameras for this match");
    }
  }

  public async proxyWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) {
      throw new Error("invalid or expired camera link");
    }
    const path = CameraService.pathForPlayer(lookup.matchId, lookup.steamId);
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ ready: boolean }> {
    const lookup = await this.validateToken(token);
    if (!lookup) {
      return { ready: false };
    }
    const path = CameraService.pathForPlayer(lookup.matchId, lookup.steamId);
    return this.getPathStatus(path);
  }

  public async proxyAdminWhep(
    matchId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertCanWatch(matchId, user);
    const path = CameraService.pathForPlayer(matchId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  public async getPlayersWithCameraStatus(
    matchId: string,
    user: User,
  ): Promise<{
    lineup_1: { id: string; name: string; players: CameraPlayerStatus[] };
    lineup_2: { id: string; name: string; players: CameraPlayerStatus[] };
  }> {
    await this.assertCanWatch(matchId, user);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        lineup_1: {
          id: true,
          name: true,
          lineup_players: {
            steam_id: true,
            player: { name: true },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          lineup_players: {
            steam_id: true,
            player: { name: true },
          },
        },
      },
    });

    if (!match?.lineup_1 || !match?.lineup_2) {
      throw new Error("match lineups not found");
    }

    // One query for every player's spot-check state, rather than one
    // per player -- this is what feeds the (⋮) menu's Request/Stop
    // toggle, so it needs to stay cheap even on a full 10-player
    // scoreboard poll.
    const { match_camera_tokens } = await this.hasura.query({
      match_camera_tokens: {
        __args: { where: { match_id: { _eq: matchId } } },
        steam_id: true,
        requested_at: true,
      },
    });
    const requestedSteamIds = new Set(
      (match_camera_tokens ?? [])
        .filter((row) => !!row.requested_at)
        .map((row) => String(row.steam_id)),
    );

    const withStatus = async (lineup: {
      id: string;
      name: string;
      lineup_players: Array<{
        steam_id: string;
        player?: { name?: string | null } | null;
      }>;
    }) => ({
      id: lineup.id,
      name: lineup.name,
      players: await Promise.all(
        (lineup.lineup_players ?? []).map(async (lineupPlayer) => {
          const path = CameraService.pathForPlayer(
            matchId,
            lineupPlayer.steam_id,
          );
          const { ready } = await this.getPathStatus(path);
          return {
            steamId: lineupPlayer.steam_id,
            name: lineupPlayer.player?.name ?? null,
            lineupId: lineup.id,
            ready,
            requested: requestedSteamIds.has(String(lineupPlayer.steam_id)),
          };
        }),
      ),
    });

    const [lineup_1, lineup_2] = await Promise.all([
      withStatus(match.lineup_1),
      withStatus(match.lineup_2),
    ]);

    return { lineup_1, lineup_2 };
  }

  // Admin "spot check" — the doping-control-style flow: pull up one
  // specific player's camera on demand, independent of whether
  // camera_required is on for the tournament as a whole. Mints (or
  // re-stamps) that player's token row so the player's own match page
  // can pick it up the same way it already does for the required flow
  // (see requested_at on public_match_camera_tokens), then shows the
  // exact same CameraRequirementOverlay component.
  public async requestSpotCheck(
    matchId: string,
    steamId: string,
    user: User,
  ): Promise<void> {
    await this.assertCanWatch(matchId, user);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        lineup_1: { lineup_players: { steam_id: true } },
        lineup_2: { lineup_players: { steam_id: true } },
      },
    });

    const isLineupPlayer = [
      ...(match?.lineup_1?.lineup_players ?? []),
      ...(match?.lineup_2?.lineup_players ?? []),
    ].some((lineupPlayer) => String(lineupPlayer.steam_id) === String(steamId));

    if (!isLineupPlayer) {
      throw new Error("player is not on either lineup for this match");
    }

    await this.postgres.query(
      `insert into match_camera_tokens (match_id, steam_id, requested_at)
       values ($1, $2, now())
       on conflict (match_id, steam_id)
       do update set requested_at = now()`,
      [matchId, steamId],
    );
  }

  // Cancels a pending/active spot check — clears requested_at so the
  // player's CameraRequirementOverlay hides itself again (its
  // showCameraOverlay check re-evaluates live off the same subscription
  // requestSpotCheck feeds). A no-op if nothing was requested; doesn't
  // touch the token itself or kill any WHIP session already in
  // progress, since a token that pre-dates the spot check (eg. one
  // camera_required already minted) must keep working afterwards.
  public async cancelSpotCheck(
    matchId: string,
    steamId: string,
    user: User,
  ): Promise<void> {
    await this.assertCanWatch(matchId, user);
    await this.postgres.query(
      `update match_camera_tokens
       set requested_at = null
       where match_id = $1 and steam_id = $2`,
      [matchId, steamId],
    );
  }

  // --- Talk mode: admin video-calls a specific player ---
  // Admin's browser WHIP-publishes mic+cam to the talk path; the
  // player's join page polls talk status and, once ready, WHEP-pulls
  // it automatically (no accept/decline step, mirrors the proven POC
  // behavior). Either side can end the call — both routes converge on
  // the same kickTalkSession, which forces MediaMTX to drop the
  // admin's publish, which is what actually ends it for both ends.

  public async proxyAdminTalkWhip(
    matchId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertCanWatch(matchId, user);
    const path = CameraService.talkPathForPlayer(matchId, steamId);
    return this.proxySdp(`/${path}/whip`, sdp);
  }

  public async proxyPlayerTalkWhep(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) {
      throw new Error("invalid or expired camera link");
    }
    const path = CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  public async getTalkStatusForToken(token: string): Promise<{ ready: boolean }> {
    const lookup = await this.validateToken(token);
    if (!lookup) return { ready: false };
    const path = CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId);
    return this.getPathStatus(path);
  }

  public async getTalkStatusForAdmin(
    matchId: string,
    steamId: string,
    user: User,
  ): Promise<{ ready: boolean }> {
    await this.assertCanWatch(matchId, user);
    const path = CameraService.talkPathForPlayer(matchId, steamId);
    return this.getPathStatus(path);
  }

  public async hangupAdminTalk(
    matchId: string,
    steamId: string,
    user: User,
  ): Promise<void> {
    await this.assertCanWatch(matchId, user);
    await this.kickTalkSession(CameraService.talkPathForPlayer(matchId, steamId));
  }

  public async hangupPlayerTalk(token: string): Promise<void> {
    const lookup = await this.validateToken(token);
    if (!lookup) return;
    await this.kickTalkSession(
      CameraService.talkPathForPlayer(lookup.matchId, lookup.steamId),
    );
  }

  private async kickTalkSession(path: string): Promise<void> {
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
      // best-effort — if MediaMTX's API is unreachable the WebRTC
      // connection will still time out and settle on its own.
      this.logger.warn(
        `[camera] kickTalkSession(${path}) failed: ${(error as Error)?.message}`,
      );
    }
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
        `[camera] proxy to mediamtx-camera failed (${targetPath}): ${(error as Error)?.message}`,
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
      if (res.status === 404) {
        return { ready: false };
      }
      if (!res.ok) {
        return { ready: false };
      }
      const json = (await res.json()) as { ready?: boolean };
      return { ready: json.ready === true };
    } catch (error) {
      this.logger.warn(
        `[camera] status check failed for ${path}: ${(error as Error)?.message}`,
      );
      return { ready: false };
    }
  }
}
