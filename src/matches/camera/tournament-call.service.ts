import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import Redis from "ioredis";
import { HasuraService } from "../../hasura/hasura.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { ChatService } from "../../chat/chat.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import {
  LobbyCallService,
  MAX_PARTICIPANTS,
  type LobbyCallParticipant,
} from "./lobby-call.service";

// Optional webcam support room inside a tournament's chat: players can get
// sign-language help from organizers/admins. Same media stack as the
// matchmaking lobby call (LobbyCallService): everyone publishes their own
// mediamtx path over WHIP and WHEP-pulls everyone else's, and presence is
// whatever mediamtx reports as live, so a closed tab or dropped connection
// frees its slot on its own.
//
// Differences from the lobby call:
// - access is tournament chat access (ChatService.canAccessTournamentChat:
//   participants, assigned organizers, administrators) plus the tournament
//   chat lifecycle (open until 24h after Finished)
// - join tokens live in Redis with a TTL (no DB table / migration)
// - the 5-person cap is re-checked atomically at publish time
// - administrators and this tournament's organizers can kick someone out
//   of the webcam room only (not the tournament, not the chat)
// - it never rings anyone: no popup, push, or notification is sent. The
//   presence events below only go to people currently in the tournament
//   chat room, on the tournament channel, which the lobby "X is calling"
//   notifier does not listen to.

export type TournamentCallParticipant = LobbyCallParticipant;

export class TournamentCallError extends Error {}

export const TOURNAMENT_CALL_FULL_MESSAGE = `Webcam room is full (${MAX_PARTICIPANTS}/${MAX_PARTICIPANTS}).`;

// Tokens outlive any realistic support session but never the tournament.
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
// A slot is held from "join" until the camera is live (then mediamtx
// presence takes over), or until this expires if they never publish.
const RESERVATION_TTL_MS = 90_000;
const CHAT_GRACE_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = [
  "Setup",
  "RegistrationOpen",
  "RegistrationClosed",
  "Live",
  "Paused",
];

// Atomic capacity check + slot reservation. KEYS[1] = reservation hash
// (steamId -> expiresAt ms). ARGV = now, expiresAt, max, self, ...live.
// Occupancy = live publishers U unexpired reservations, excluding self.
const RESERVE_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = ARGV[2]
local max = tonumber(ARGV[3])
local self = ARGV[4]
local occupied = {}
local count = 0
local entries = redis.call('HGETALL', KEYS[1])
for i = 1, #entries, 2 do
  if tonumber(entries[i + 1]) <= now then
    redis.call('HDEL', KEYS[1], entries[i])
  elseif entries[i] ~= self and not occupied[entries[i]] then
    occupied[entries[i]] = true
    count = count + 1
  end
end
for i = 5, #ARGV do
  if ARGV[i] ~= self and not occupied[ARGV[i]] then
    occupied[ARGV[i]] = true
    count = count + 1
  end
end
if count >= max then return 0 end
redis.call('HSET', KEYS[1], self, expiresAt)
redis.call('PEXPIRE', KEYS[1], ${RESERVATION_TTL_MS * 2})
return 1
`;

@Injectable()
export class TournamentCallService {
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly chat: ChatService,
    private readonly media: LobbyCallService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public static pathPrefix(tournamentId: string): string {
    return `camera-tournament-${tournamentId}-`;
  }

  public static pathFor(tournamentId: string, steamId: string): string {
    return `${TournamentCallService.pathPrefix(tournamentId)}${steamId}`;
  }

  private tokenKey(token: string) {
    return `tournament-call:token:${token}`;
  }

  private userTokenKey(tournamentId: string, steamId: string) {
    return `tournament-call:user:${tournamentId}:${steamId}`;
  }

  private reservationKey(tournamentId: string) {
    return `tournament-call:reserve:${tournamentId}`;
  }

  // The tournament chat's own window: open statuses, or Finished less
  // than 24h ago (same rule the Chat Hub uses to list tournament rooms).
  private async isWithinChatLifecycle(tournamentId: string): Promise<boolean> {
    const { tournaments_by_pk } = await this.hasura.query({
      tournaments_by_pk: {
        __args: { id: tournamentId },
        status: true,
        finished_at: true,
      },
    });
    if (!tournaments_by_pk) return false;
    const status = String(tournaments_by_pk.status);
    if (OPEN_STATUSES.includes(status)) return true;
    if (status !== "Finished" || !tournaments_by_pk.finished_at) return false;
    return (
      Date.parse(String(tournaments_by_pk.finished_at)) >=
      Date.now() - CHAT_GRACE_MS
    );
  }

  public async canUse(tournamentId: string, steamId: string): Promise<boolean> {
    if (!tournamentId || !steamId) return false;
    if (!(await this.isWithinChatLifecycle(tournamentId))) return false;
    return this.chat.canAccessTournamentChat(tournamentId, String(steamId));
  }

  private async assertCanUse(tournamentId: string, steamId: string) {
    if (!(await this.canUse(tournamentId, steamId))) {
      throw new TournamentCallError(
        "You do not have access to this tournament's webcam room",
      );
    }
  }

  // Administrator role, or explicitly assigned organizer of THIS
  // tournament (is_organizer is evaluated with the caller's own Hasura
  // role: administrators, tournaments.organizer_steam_id, or a
  // tournament_organizers row). Moderators get nothing by role.
  public async canKick(tournamentId: string, user: User): Promise<boolean> {
    if (!user?.steam_id) return false;
    if (user.role === "administrator") return true;
    const { tournaments } = await this.hasura.query(
      {
        tournaments: {
          __args: {
            where: {
              id: { _eq: tournamentId },
              is_organizer: { _eq: true },
            },
          },
          id: true,
        },
      },
      String(user.steam_id),
    );
    return (tournaments ?? []).length > 0;
  }

  private async reserveSlot(
    tournamentId: string,
    steamId: string,
    liveSteamIds: string[],
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.redis.eval(
      RESERVE_SLOT_SCRIPT,
      1,
      this.reservationKey(tournamentId),
      String(now),
      String(now + RESERVATION_TTL_MS),
      String(MAX_PARTICIPANTS),
      String(steamId),
      ...liveSteamIds.map(String),
    );
    return Number(result) === 1;
  }

  private async releaseSlot(tournamentId: string, steamId: string) {
    await this.redis.hdel(this.reservationKey(tournamentId), String(steamId));
  }

  private async claimSlot(tournamentId: string, steamId: string) {
    const live = await this.getParticipants(tournamentId);
    if (live.some((p) => p.steamId === String(steamId))) return;
    const ok = await this.reserveSlot(
      tournamentId,
      steamId,
      live.map((p) => p.steamId),
    );
    if (!ok) throw new TournamentCallError(TOURNAMENT_CALL_FULL_MESSAGE);
  }

  public async join(
    tournamentId: string,
    user: User,
  ): Promise<{
    token: string;
    participants: TournamentCallParticipant[];
    canKick: boolean;
    max: number;
  }> {
    const steamId = String(user.steam_id);
    await this.assertCanUse(tournamentId, steamId);

    const participants = await this.getParticipants(tournamentId);
    const alreadyIn = participants.some((p) => p.steamId === steamId);
    if (!alreadyIn) await this.claimSlot(tournamentId, steamId);

    let token = await this.redis.get(this.userTokenKey(tournamentId, steamId));
    if (!token || !(await this.redis.exists(this.tokenKey(token)))) {
      token = randomUUID();
    }
    await this.redis
      .multi()
      .set(
        this.tokenKey(token),
        JSON.stringify({ tournamentId, steamId }),
        "EX",
        TOKEN_TTL_SECONDS,
      )
      .set(
        this.userTokenKey(tournamentId, steamId),
        token,
        "EX",
        TOKEN_TTL_SECONDS,
      )
      .exec();

    if (!alreadyIn) {
      void this.broadcastPresence(tournamentId, steamId, "call-joining");
    }

    return {
      token,
      participants,
      canKick: await this.canKick(tournamentId, user),
      max: MAX_PARTICIPANTS,
    };
  }

  public async validateToken(
    token: string,
  ): Promise<{ tournamentId: string; steamId: string } | null> {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!token || !UUID_RE.test(token)) return null;
    const raw = await this.redis.get(this.tokenKey(token));
    if (!raw) return null;
    let lookup: { tournamentId: string; steamId: string };
    try {
      lookup = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!lookup?.tournamentId || !lookup?.steamId) return null;
    // Access is re-checked on every use: losing tournament access, or the
    // chat window closing, invalidates the link immediately.
    if (!(await this.canUse(lookup.tournamentId, lookup.steamId))) return null;
    return lookup;
  }

  public async proxyWhip(token: string, sdp: string): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup)
      throw new TournamentCallError("invalid or expired webcam link");

    // Hard cap at publish time too: someone may have sat on the device
    // picker long enough for their join-time reservation to lapse.
    await this.claimSlot(lookup.tournamentId, lookup.steamId);

    const path = TournamentCallService.pathFor(
      lookup.tournamentId,
      lookup.steamId,
    );
    const answer = await this.media.proxySdp(`/${path}/whip`, sdp);
    void this.broadcastPresence(
      lookup.tournamentId,
      lookup.steamId,
      "call-joined",
    );
    return answer;
  }

  public async getStatusForToken(
    token: string,
  ): Promise<{ ready: boolean; steamId?: string }> {
    const lookup = await this.validateToken(token);
    if (!lookup) return { ready: false };
    const status = await this.media.getPathStatus(
      TournamentCallService.pathFor(lookup.tournamentId, lookup.steamId),
    );
    return { ...status, steamId: lookup.steamId };
  }

  public async hangupForToken(token: string): Promise<void> {
    // Hang-up must work even if access was just lost, so read the token
    // directly instead of through validateToken.
    const raw = await this.redis.get(this.tokenKey(token ?? ""));
    if (!raw) return;
    let lookup: { tournamentId: string; steamId: string };
    try {
      lookup = JSON.parse(raw);
    } catch {
      return;
    }
    await this.removeFromRoom(lookup.tournamentId, lookup.steamId, false);
  }

  public async proxyPeerWhep(
    tournamentId: string,
    steamId: string,
    user: User,
    sdp: string,
  ): Promise<string> {
    await this.assertCanUse(tournamentId, String(user.steam_id));
    const path = TournamentCallService.pathFor(tournamentId, steamId);
    return this.media.proxySdp(`/${path}/whep`, sdp);
  }

  public async proxyPeerWhepForToken(
    token: string,
    steamId: string,
    sdp: string,
  ): Promise<string> {
    const lookup = await this.validateToken(token);
    if (!lookup)
      throw new TournamentCallError("invalid or expired webcam link");
    const path = TournamentCallService.pathFor(lookup.tournamentId, steamId);
    return this.media.proxySdp(`/${path}/whep`, sdp);
  }

  // Live publishers per mediamtx. Anyone who no longer has access (left
  // the tournament, organizer removed, chat window closed) is dropped
  // from the room here, so they cannot keep holding one of the 5 slots.
  public async getParticipants(
    tournamentId: string,
  ): Promise<TournamentCallParticipant[]> {
    const live = await this.media.participantsForPrefix(
      TournamentCallService.pathPrefix(tournamentId),
    );
    const kept: TournamentCallParticipant[] = [];
    for (const participant of live) {
      if (await this.canUse(tournamentId, participant.steamId)) {
        kept.push(participant);
        // Live now, so mediamtx presence counts them; drop the join-time
        // reservation so a later disconnect frees the slot immediately.
        await this.releaseSlot(tournamentId, participant.steamId);
      } else {
        await this.removeFromRoom(tournamentId, participant.steamId, false);
      }
    }
    return kept;
  }

  public async getParticipantsForUser(
    tournamentId: string,
    user: User,
  ): Promise<{
    participants: TournamentCallParticipant[];
    canKick: boolean;
    max: number;
  }> {
    await this.assertCanUse(tournamentId, String(user.steam_id));
    return {
      participants: await this.getParticipants(tournamentId),
      canKick: await this.canKick(tournamentId, user),
      max: MAX_PARTICIPANTS,
    };
  }

  public async getParticipantsForToken(
    token: string,
  ): Promise<TournamentCallParticipant[]> {
    const lookup = await this.validateToken(token);
    if (!lookup) return [];
    return this.getParticipants(lookup.tournamentId);
  }

  // Frees a webcam slot. Only disconnects the target's camera: they stay
  // in the tournament and its chat, are not muted or sanctioned, and can
  // join again right away (they just need to press join again).
  public async kick(
    tournamentId: string,
    targetSteamId: string,
    user: User,
  ): Promise<void> {
    if (!(await this.canKick(tournamentId, user))) {
      throw new TournamentCallError(
        "Only administrators and this tournament's organizers can remove people from the webcam room",
      );
    }
    await this.removeFromRoom(tournamentId, String(targetSteamId), true);
  }

  private async removeFromRoom(
    tournamentId: string,
    steamId: string,
    kicked: boolean,
  ): Promise<void> {
    await this.media.kickPath(
      TournamentCallService.pathFor(tournamentId, steamId),
    );
    await this.releaseSlot(tournamentId, steamId);
    if (kicked) {
      // Drop their link so an open phone/popup page cannot silently
      // republish into the freed slot. Normal eligibility is unchanged.
      const token = await this.redis.get(
        this.userTokenKey(tournamentId, steamId),
      );
      if (token) await this.redis.del(this.tokenKey(token));
      await this.redis.del(this.userTokenKey(tournamentId, steamId));
    }
    void this.broadcastPresence(tournamentId, steamId, "call-left", { kicked });
  }

  private async broadcastPresence(
    tournamentId: string,
    steamId: string,
    event: "call-joined" | "call-left" | "call-joining",
    extra: Record<string, unknown> = {},
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
      await this.chat.to(ChatLobbyType.Tournament, tournamentId, event, {
        steamId,
        name: players_by_pk?.name ?? null,
        avatarUrl:
          (players_by_pk?.custom_avatar_url || players_by_pk?.avatar_url) ??
          null,
        ...extra,
      });
    } catch (error) {
      this.logger.warn(
        `[tournament-call] presence broadcast failed: ${(error as Error)?.message}`,
      );
    }
  }
}
