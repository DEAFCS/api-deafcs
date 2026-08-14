import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { ChatService } from "../../chat/chat.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";

// Optional multi-party webcam call for a matchmaking lobby's queue chat
// -- distinct from CameraService's tournament required-webcam feature
// (token-minted server-side on veto->Live, enforced via a blocking
// overlay). This is opt-in: any accepted lobby member can start/join
// at will, nobody is forced into it, capped at MAX_PARTICIPANTS.
//
// Reuses the exact same shape as the required-webcam feature on
// purpose (WHIP publish on your own path, WHEP pull on everyone
// else's) rather than inventing a new signaling model -- mediamtx
// already fans a single published stream out to any number of WHEP
// viewers, so "group call" here is really just "everyone in the lobby
// publishes their own path and WHEP-pulls everyone else's".
const MAX_PARTICIPANTS = 5;

export type LobbyCallParticipant = {
  steamId: string;
  name: string | null;
  avatarUrl: string | null;
};

@Injectable()
export class LobbyCallService {
  private readonly mediaMtxHost: string;
  private readonly whipPort: string;
  private readonly apiPort: string;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly chat: ChatService,
  ) {
    this.mediaMtxHost = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
    this.whipPort = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
    this.apiPort = process.env.MEDIAMTX_CAMERA_API_PORT || "9998";
  }

  public static pathFor(lobbyId: string, steamId: string): string {
    return `camera-lobby-${lobbyId}-${steamId}`;
  }

  private async assertLobbyMember(lobbyId: string, steamId: string): Promise<void> {
    const { lobby_players_by_pk } = await this.hasura.query({
      lobby_players_by_pk: {
        __args: { lobby_id: lobbyId, steam_id: steamId },
        status: true,
      },
    });
    if (lobby_players_by_pk?.status !== "Accepted") {
      throw new Error("not a member of this lobby");
    }
  }

  // Mints (or reuses) a join token for the caller, matching the
  // required-webcam feature's QR/popup pattern exactly -- both the
  // phone-QR and the "this computer" popup open the same token-gated
  // join page, no session round-trips needed once there.
  public async join(
    lobbyId: string,
    user: User,
  ): Promise<{ token: string; participants: LobbyCallParticipant[] }> {
    await this.assertLobbyMember(lobbyId, user.steam_id);

    const participants = await this.getParticipants(lobbyId);
    const alreadyIn = participants.some((p) => p.steamId === user.steam_id);
    if (!alreadyIn && participants.length >= MAX_PARTICIPANTS) {
      throw new Error(`lobby call is full (max ${MAX_PARTICIPANTS})`);
    }

    const rows = await this.postgres.query<Array<{ token: string }>>(
      `INSERT INTO public.lobby_camera_tokens (lobby_id, steam_id)
       VALUES ($1, $2)
       ON CONFLICT (lobby_id, steam_id) DO UPDATE SET lobby_id = EXCLUDED.lobby_id
       RETURNING token`,
      [lobbyId, user.steam_id],
    );

    // Tell whoever's already in the call that this player is on their
    // way in -- their camera isn't live yet (that's the separate
    // "call-joined" broadcast, fired once WHIP actually connects), but
    // the people already there should see a "waiting for camera…"
    // placeholder rather than nothing until then. Skip if they were
    // already a participant (re-fetching an existing token, not a
    // fresh join).
    if (!alreadyIn) {
      void this.broadcastPresence(lobbyId, user.steam_id, "call-joining");
    }

    return { token: rows[0].token, participants };
  }

  public async validateToken(
    token: string,
  ): Promise<{ lobbyId: string; steamId: string } | null> {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;

    const rows = await this.postgres.query<
      Array<{ lobby_id: string; steam_id: string }>
    >(
      `SELECT lobby_id, steam_id FROM public.lobby_camera_tokens WHERE token = $1`,
      [token],
    );
    const row = rows[0];
    if (!row) return null;

    try {
      await this.assertLobbyMember(row.lobby_id, row.steam_id);
    } catch {
      return null;
    }

    return { lobbyId: row.lobby_id, steamId: row.steam_id };
  }

  public async proxyWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired lobby call link");

    const path = LobbyCallService.pathFor(lookup.lobbyId, lookup.steamId);
    const answer = await this.proxySdp(`/${path}/whip`, sdp);

    void this.broadcastPresence(lookup.lobbyId, lookup.steamId, "call-joined");

    return answer;
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ ready: boolean; steamId?: string }> {
    const lookup = await this.validateToken(token);
    if (!lookup) return { ready: false };
    const status = await this.getPathStatus(
      LobbyCallService.pathFor(lookup.lobbyId, lookup.steamId),
    );
    // The anonymous QR/phone join page has no session to know its own
    // steamId from -- it needs this to exclude its own tile when
    // pulling WHEP for everyone else in the call.
    return { ...status, steamId: lookup.steamId };
  }

  public async hangupForToken(token: string): Promise<void> {
    const lookup = await this.validateToken(token);
    if (!lookup) return;
    await this.kickPath(LobbyCallService.pathFor(lookup.lobbyId, lookup.steamId));
    void this.broadcastPresence(lookup.lobbyId, lookup.steamId, "call-left");
  }

  public async proxyPeerWhep(
    lobbyId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertLobbyMember(lobbyId, user.steam_id);
    const path = LobbyCallService.pathFor(lobbyId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  // Active participants right now, resolved by asking mediamtx which
  // camera-lobby-{lobbyId}-* paths are actually publishing (not
  // tracked separately in our own DB/Redis -- mediamtx is already the
  // source of truth the rest of this feature relies on).
  public async getParticipants(lobbyId: string): Promise<LobbyCallParticipant[]> {
    const prefix = `camera-lobby-${lobbyId}-`;
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
          .map((p) => p.name.slice(prefix.length));
      }
    } catch (error) {
      this.logger.warn(
        `[lobby-call] failed to list active paths: ${(error as Error)?.message}`,
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
    lobbyId: string,
    user: User,
  ): Promise<LobbyCallParticipant[]> {
    await this.assertLobbyMember(lobbyId, user.steam_id);
    return this.getParticipants(lobbyId);
  }

  // Token-gated equivalents of proxyPeerWhep/getParticipantsForUser above
  // -- for the anonymous QR/phone join page, which has no session to
  // resolve a User from. The token itself already proves lobby
  // membership (validateToken re-checks it's still Accepted).
  public async getParticipantsForToken(token: string): Promise<LobbyCallParticipant[]> {
    const lookup = await this.validateToken(token);
    if (!lookup) return [];
    return this.getParticipants(lookup.lobbyId);
  }

  public async proxyPeerWhepForToken(
    token: string,
    steamId: string,
    sdp: string,
  ): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup) throw new Error("invalid or expired lobby call link");
    const path = LobbyCallService.pathFor(lookup.lobbyId, steamId);
    return this.proxySdp(`/${path}/whep`, sdp);
  }

  private async broadcastPresence(
    lobbyId: string,
    steamId: string,
    event: "call-joined" | "call-left" | "call-joining",
  ): Promise<void> {
    try {
      const { players_by_pk } = await this.hasura.query({
        players_by_pk: {
          __args: { steam_id: steamId },
          steam_id: true,
          name: true,
          avatar_url: true,
          custom_avatar_url: true,
        },
      });

      await this.chat.to(ChatLobbyType.MatchMaking, lobbyId, event, {
        steamId,
        name: players_by_pk?.name ?? null,
        avatarUrl:
          (players_by_pk?.custom_avatar_url || players_by_pk?.avatar_url) ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `[lobby-call] presence broadcast failed: ${(error as Error)?.message}`,
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
        `[lobby-call] proxy to mediamtx-camera failed (${targetPath}): ${(error as Error)?.message}`,
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
        `[lobby-call] kickPath(${path}) failed: ${(error as Error)?.message}`,
      );
    }
  }
}
