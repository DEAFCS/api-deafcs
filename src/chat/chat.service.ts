import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import {
  e_player_roles_enum,
  e_notification_types_enum,
} from "generated/schema";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { NotificationsService } from "../notifications/notifications.service";
import { BlocksService } from "src/blocks/blocks.service";
import { v4 as uuidv4 } from "uuid";
import { createHash, randomBytes } from "crypto";
import { S3Service } from "../s3/s3.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  ChatVideoQueues,
  ExpireSentChatVideoMediaJobName,
} from "./enums/ChatVideoQueues";
import {
  WebsiteRestrictionsService,
  WebsiteRestrictionStatus,
} from "src/website-restrictions/website-restrictions.service";

type WebsiteChatMuteStatus = {
  active: boolean;
  expiresAt: string | null;
  permanent: boolean;
};

// Fixed id for the single, site-wide Announcements channel -- same
// shape as Global's fixed "global" id, see joinMatchLobby. Deliberately
// identical to ChatLobbyType.Announcement's own string value ("announcement"),
// matching the Global/Organizer convention of type-string === id-string --
// entity_id (`${type}:${id}`, see notifyLobbyMembers) and the frontend's
// notification-click routing both rely on that equality.
export const ANNOUNCEMENTS_LOBBY_ID = "announcement";

export const CHAT_REACTION_IDS = [
  "thumbsup",
  "heart",
  "fire",
  "party",
] as const;

export type ChatReactionId = (typeof CHAT_REACTION_IDS)[number];

const CHAT_REACTION_TOGGLE_LUA = `
  if redis.call('EXISTS', KEYS[3]) == 1 then return {0, 0, -2} end
  local ttlMs = nil
  if ARGV[4] ~= 'announcement' then
    local stored = redis.call('HGET', KEYS[1], ARGV[1])
    if not stored or stored ~= ARGV[2] then return {0, 0, -2} end
    local fieldTtl = redis.call('HPTTL', KEYS[1], 'FIELDS', 1, ARGV[1])
    ttlMs = tonumber(fieldTtl[1])
    if not ttlMs or ttlMs <= 0 then return {0, 0, ttlMs or -1} end
  else
    redis.call('PERSIST', KEYS[2])
  end

  local removed = redis.call('SREM', KEYS[2], ARGV[3])
  local active = 0
  if removed == 0 then
    redis.call('SADD', KEYS[2], ARGV[3])
    active = 1
  end
  if ttlMs then redis.call('PEXPIRE', KEYS[2], ttlMs) end
  local count = redis.call('SCARD', KEYS[2])
  if count == 0 then redis.call('DEL', KEYS[2]) end
  return {1, active, count, ttlMs or 0}
`;

// Authors may edit/delete their own website chat message for this long
// after it was sent (server clock, inclusive). Administrators keep
// moderation delete at any age, but never edit someone else's message.
export const CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS = 10 * 60 * 1000;

// One product limit for website chat text, enforced on send and edit
// (including announcements). Never applied by truncating: over-length
// text is refused. Existing longer messages are left as they are.
// Game-relayed lines and Short Video media are not website text.
export const CHAT_MESSAGE_MAX_LENGTH = 2000;
export const CHAT_MESSAGE_TOO_LONG_ERROR =
  "Message can be up to 2,000 characters.";

export function isChatMessageTooLong(message: string) {
  return message.length > CHAT_MESSAGE_MAX_LENGTH;
}

// Stored timestamps come from the API's own clock, so only a tiny skew
// between pods is tolerated for a message that appears to be "from the
// future".
const CHAT_MESSAGE_CLOCK_SKEW_MS = 5000;

// Compare-and-swap edit of one Redis hash field. HSET on an existing
// field clears its field expiry, so the field's original *absolute*
// expiry (HPEXPIRETIME, unix ms) is read first and restored exactly with
// HPEXPIREAT -- an edit can never extend a message's lifetime, not even
// by the time the script takes. HPEXPIRETIME: -2 = no such field (refused),
// -1 = persistent field (kept persistent), otherwise the expiry.
// Returns {1, expireAtMs} on success, {0, reason} otherwise.
const CHAT_MESSAGE_EDIT_LUA = `
  if redis.call('EXISTS', KEYS[2]) == 1 then return {0, -3} end
  local stored = redis.call('HGET', KEYS[1], ARGV[1])
  if not stored or stored ~= ARGV[2] then return {0, -2} end
  local fieldExpiry = redis.call('HPEXPIRETIME', KEYS[1], 'FIELDS', 1, ARGV[1])
  local expireAtMs = tonumber(fieldExpiry[1])
  if not expireAtMs or expireAtMs == -2 then return {0, -2} end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  if expireAtMs > 0 then
    redis.call('HPEXPIREAT', KEYS[1], expireAtMs, 'FIELDS', 1, ARGV[1])
  end
  return {1, expireAtMs}
`;

const CHAT_REACTION_DELETE_LUA = `
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
  for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end
  return 1
`;

// Terminal match statuses -- same set MatchActions.vue (frontend) and
// notifyMatchPlayersOfSanction already treat as "this match is over".
// Used to gate the post-match admin chat-log bypass in joinMatchLobby.
const MATCH_ENDED_STATUSES: string[] = [
  "Finished",
  "Forfeit",
  "Surrendered",
  "Tie",
  "Canceled",
];

@Injectable()
export class ChatService {
  private redis: Redis;

  private expiresIn = 60 * 60 * 24;

  // Match and team chat get a much longer retention than the default
  // (see expiresIn) so an admin can still pull up the post-match chat
  // log (see joinMatchLobby's Finished-match admin bypass below) days
  // after the match itself has already dropped off the match page for
  // everyone else. Every other lobby type keeps the default.
  private static readonly MATCH_CHAT_TTL_SECONDS = 60 * 60 * 24 * 7;

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    private readonly notifications: NotificationsService,
    private readonly blocks: BlocksService,
    private readonly websiteRestrictions: WebsiteRestrictionsService,
    private readonly s3: S3Service = null as any,
    @InjectQueue(ChatVideoQueues.DraftExpiry)
    private readonly chatVideoCleanupQueue: Queue = null as any,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async updateChatMessageTTL(expiresIn: number) {
    this.expiresIn = expiresIn;
  }

  private getChatMessageTtlSeconds(type: ChatLobbyType) {
    return type === ChatLobbyType.Match || type === ChatLobbyType.MatchTeam
      ? ChatService.MATCH_CHAT_TTL_SECONDS
      : this.expiresIn;
  }

  public async joinMatchLobby(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    id: string,
    historyRequestId?: number,
  ) {
    const user = await this.refreshClientUser(client);
    if (!user) {
      return;
    }

    switch (type) {
      case ChatLobbyType.Match:
        const { matches_by_pk } = await this.hasuraService.query(
          {
            matches_by_pk: {
              __args: {
                id,
              },
              is_coach: true,
              is_organizer: true,
              is_in_lineup: true,
            },
          },
          user.steam_id,
        );

        if (!matches_by_pk) {
          return;
        }

        if (
          matches_by_pk.is_coach === false &&
          matches_by_pk.is_in_lineup === false &&
          matches_by_pk.is_organizer === false
        ) {
          return;
        }

        break;
      case ChatLobbyType.MatchTeam: {
        const [matchId, lineupId] = id.split(":");

        if (!matchId || !lineupId) {
          return;
        }

        const { match_lineups_by_pk } = await this.hasuraService.query(
          {
            match_lineups_by_pk: {
              __args: { id: lineupId },
              id: true,
              match_id: true,
              coach_steam_id: true,
              is_on_lineup: true,
              match: {
                status: true,
              },
            },
          },
          user.steam_id,
        );

        // An admin can read either team's private chat, but only once the
        // match is actually over -- unlike the shared Match-type chat
        // above (already effectively admin-visible any time, since
        // is_match_organizer.sql treats every administrator as an
        // organizer of every match), peeking at a *live* team's private
        // strategy chat would be a real fairness problem, not just a
        // formality. Reported: an admin reviewing a finished match for
        // toxicity had no way to open the other team's chat at all.
        const isFinishedMatchAdmin =
          MATCH_ENDED_STATUSES.includes(
            match_lineups_by_pk?.match?.status as string,
          ) && isRoleAbove(user.role, "administrator");

        if (
          !match_lineups_by_pk ||
          match_lineups_by_pk.match_id !== matchId ||
          (!match_lineups_by_pk.is_on_lineup &&
            String(match_lineups_by_pk.coach_steam_id) !==
              String(user.steam_id) &&
            !isFinishedMatchAdmin)
        ) {
          return;
        }

        break;
      }
      case ChatLobbyType.MatchMaking:
        const { lobby_players_by_pk } = await this.hasuraService.query({
          lobby_players_by_pk: {
            __args: {
              lobby_id: id,
              steam_id: user.steam_id,
            },
            status: true,
          },
        });

        if (lobby_players_by_pk?.status !== "Accepted") {
          return;
        }

        break;
      case ChatLobbyType.Tournament:
        if (!(await this.canAccessTournamentChat(id, user.steam_id))) {
          return;
        }
        break;
      case ChatLobbyType.Draft: {
        if (isRoleAbove(user.role, "match_organizer")) {
          break;
        }

        const { draft_games } = await this.hasuraService.query({
          draft_games: {
            __args: {
              where: {
                id: { _eq: id },
                _or: [
                  { access: { _eq: "Open" } },
                  { host_steam_id: { _eq: user.steam_id } },
                  { players: { steam_id: { _eq: user.steam_id } } },
                ],
              },
            },
            id: true,
          },
        });

        if (draft_games.length === 0) {
          return;
        }

        break;
      }
      case ChatLobbyType.Organizer:
        if (!isRoleAbove(user.role, "match_organizer")) {
          return;
        }

        break;
      case ChatLobbyType.Global:
        if (!isRoleAbove(user.role, "verified_user")) {
          return;
        }

        break;
      case ChatLobbyType.Announcement:
        // Read access is open to every logged-in player, including the
        // base "user" role -- narrower than Global (verified_user+) on
        // purpose, per explicit request. Posting is gated separately,
        // in sendMessageToChat, to administrator only.
        break;
      case ChatLobbyType.Direct: {
        const parties = id.split(":");
        if (parties.length !== 2 || !parties.includes(String(user.steam_id))) {
          return;
        }

        // Everyone -- including admins -- can only DM an accepted friend.
        // Opening a DM used to only check that the requester was one of
        // the two parties in the id, which anyone can derive from any
        // two steam ids (it's just a sorted pair), so this was the only
        // thing actually stopping unsolicited DMs to strangers.
        {
          const otherSteamId = parties.find((p) => p !== String(user.steam_id));
          const { friends } = await this.hasuraService.query({
            friends: {
              __args: {
                where: {
                  status: { _eq: "Accepted" },
                  _or: [
                    {
                      player_steam_id: { _eq: user.steam_id },
                      other_player_steam_id: { _eq: otherSteamId },
                    },
                    {
                      player_steam_id: { _eq: otherSteamId },
                      other_player_steam_id: { _eq: user.steam_id },
                    },
                  ],
                },
                limit: 1,
              },
              player_steam_id: true,
            },
          });
          if (friends.length === 0) {
            return;
          }

          // Explicit, not just relying on blocking having already removed
          // the friendship row above -- keeps this join path correct on
          // its own even if the DM/friendship coupling ever changes, and
          // covers reconnects/refreshes the same as a fresh open.
          if (
            await this.blocks.isBlockedEitherDirection(
              user.steam_id,
              otherSteamId,
            )
          ) {
            return;
          }
        }
        break;
      }
      default:
        this.logger.warn(`Unknown lobby type: ${type}`);
        return;
    }

    const userData = await this.addUserToLobby(type, id, user, false);

    const [added, count] = await this.addSession(
      type,
      id,
      user.steam_id,
      client.id,
    );

    if (added === 1 && count === 1) {
      void this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }

    const allUsers = await this.getAllUsersInLobby(type, id);

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:list`,
        data: {
          lobby: allUsers.map(({ user, inGame }) => ({
            inGame,
            ...user,
          })),
        },
      }),
    );

    // Announcements are persisted in Postgres, not the Redis 24h-TTL
    // hash every other chat type uses -- see ANNOUNCEMENTS_LOBBY_ID's
    // comment for why.
    let messages: Array<Record<string, any>>;
    if (type === ChatLobbyType.Announcement) {
      messages = await this.getAnnouncementMessages();
    } else {
      const deletedIds = await this.getDeletedMessageIds(type, id);
      messages = Object.entries(await this.redis.hgetall(`chat_${type}_${id}`))
        .map(([, value]) => JSON.parse(value))
        .filter((message) => !deletedIds.has(String(message.id)));

      // Per-viewer redaction: a shared room (Global, Team, Match, ...)
      // shows the same message list to everyone except who the *joining*
      // viewer personally blocked -- other members still see those
      // messages normally, and the underlying content is never deleted
      // (see chat_message_deletions for the actual admin-delete audit
      // trail, a completely different, global mechanism). Direct is
      // excluded: a DM's only "other party" is already refused at join
      // time and at send time when blocked, so there's no third party to
      // filter and no benefit to redacting your own 1:1 history.
      if (type !== ChatLobbyType.Direct) {
        const blockedSteamIds = await this.blocks.getMyBlockedSteamIds(
          user.steam_id,
        );
        if (blockedSteamIds.size > 0) {
          messages = messages.map((message) =>
            this.redactIfBlocked(message, blockedSteamIds),
          );
        }
      }
    }

    messages = await this.addReactionStateToMessages(messages, user.steam_id);

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:messages`,
        data: {
          id,
          ...(historyRequestId == null ? {} : { historyRequestId }),
          messages: messages.sort((a, b) => {
            return (
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
          }),
        },
      }),
    );

    client.send(
      JSON.stringify({
        event: "chat:mute-status",
        data: await this.getWebsiteChatMuteStatus(user.steam_id),
      }),
    );

    client.send(
      JSON.stringify({
        event: "account:restriction-status",
        data: await this.websiteRestrictions.getStatus(user.steam_id),
      }),
    );

    client.on("close", () => {
      void this.removeFromLobby(type, id, client);
    });
  }

  private async refreshClientUser(client: FiveStackWebSocketClient) {
    if (!client.user?.steam_id) {
      return;
    }

    const currentUser = await this.getCurrentUser(client.user.steam_id);
    if (!currentUser) {
      return;
    }

    client.user = {
      ...client.user,
      ...currentUser,
    };

    return client.user;
  }

  public async toggleChatMessageReaction(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
    reaction: string,
  ): Promise<boolean> {
    if (
      !roomId ||
      !messageId ||
      !this.isUuid(messageId) ||
      !CHAT_REACTION_IDS.includes(reaction as ChatReactionId) ||
      !Object.values(ChatLobbyType).includes(type)
    ) {
      return false;
    }

    const user = await this.refreshClientUser(client);
    if (!user) return false;
    if ((await this.websiteRestrictions.getStatus(user.steam_id)).active)
      return false;
    if ((await this.getWebsiteChatMuteStatus(user.steam_id)).active)
      return false;
    if (!(await this.hasCurrentChatRoomAccess(client, type, roomId, user)))
      return false;

    let expectedStoredMessage: string | undefined;
    if (type === ChatLobbyType.Announcement) {
      if (roomId !== ANNOUNCEMENTS_LOBBY_ID) return false;
      const rows = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id::text AS id
           FROM public.announcements
          WHERE id = $1::uuid AND deleted_at IS NULL
          LIMIT 1`,
        [messageId],
      );
      if (!rows[0]) return false;
    } else {
      const messageKey = `chat_${type}_${roomId}`;
      expectedStoredMessage =
        (await this.redis.hget(messageKey, messageId)) ?? undefined;
      if (!expectedStoredMessage) return false;

      let storedMessage: Record<string, any>;
      try {
        storedMessage = JSON.parse(expectedStoredMessage);
      } catch {
        return false;
      }
      if (
        String(storedMessage?.id ?? "") !== messageId ||
        !storedMessage?.from?.steam_id ||
        !storedMessage?.timestamp ||
        Number.isNaN(new Date(storedMessage.timestamp).getTime()) ||
        (typeof storedMessage.message !== "string" &&
          storedMessage.media?.type !== "video")
      ) {
        return false;
      }

      if ((await this.getDeletedMessageIds(type, roomId)).has(messageId))
        return false;

      if (type !== ChatLobbyType.Direct) {
        const blockedSteamIds = await this.blocks.getMyBlockedSteamIds(
          user.steam_id,
        );
        if (blockedSteamIds.has(String(storedMessage.from.steam_id)))
          return false;
      }
    }

    const messageKey = `chat_${type}_${roomId}`;
    const reactionKey = this.chatReactionKey(messageId, reaction);
    const deletedKey = this.chatReactionDeletedKey(messageId);
    const result = (await this.redis.eval(
      CHAT_REACTION_TOGGLE_LUA,
      3,
      messageKey,
      reactionKey,
      deletedKey,
      messageId,
      expectedStoredMessage ?? "",
      String(user.steam_id),
      type === ChatLobbyType.Announcement ? "announcement" : "chat",
    )) as [number, number, number, number?];

    if (Number(result?.[0]) !== 1) return false;
    void this.to(type, roomId, "reaction", {
      messageId,
      reaction,
      count: Number(result[2]),
      active: Number(result[1]) === 1,
      actorSteamId: String(user.steam_id),
    });
    return true;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private chatReactionKey(messageId: string, reaction: string) {
    return `chat:reaction:${messageId}:${reaction}`;
  }

  private chatReactionDeletedKey(messageId: string) {
    return `chat:reaction:deleted:${messageId}`;
  }

  private async hasCurrentChatRoomAccess(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    id: string,
    user: User,
  ): Promise<boolean> {
    if (
      !(await this.getUserData(type, id, String(user.steam_id))) ||
      !(await this.redis.sismember(
        this.sessionsKey(type, id, String(user.steam_id)),
        String(client.id),
      ))
    ) {
      return false;
    }

    switch (type) {
      case ChatLobbyType.Match: {
        const { matches_by_pk } = await this.hasuraService.query(
          {
            matches_by_pk: {
              __args: { id },
              is_coach: true,
              is_organizer: true,
              is_in_lineup: true,
            },
          },
          user.steam_id,
        );
        return Boolean(
          matches_by_pk &&
          (matches_by_pk.is_coach ||
            matches_by_pk.is_organizer ||
            matches_by_pk.is_in_lineup),
        );
      }
      case ChatLobbyType.MatchTeam: {
        const [matchId, lineupId] = id.split(":");
        if (!matchId || !lineupId) return false;
        const { match_lineups_by_pk } = await this.hasuraService.query(
          {
            match_lineups_by_pk: {
              __args: { id: lineupId },
              id: true,
              match_id: true,
              coach_steam_id: true,
              is_on_lineup: true,
              match: { status: true },
            },
          },
          user.steam_id,
        );
        const isFinishedMatchAdmin =
          MATCH_ENDED_STATUSES.includes(
            match_lineups_by_pk?.match?.status as string,
          ) && isRoleAbove(user.role, "administrator");
        return Boolean(
          match_lineups_by_pk &&
          String(match_lineups_by_pk.match_id) === matchId &&
          (match_lineups_by_pk.is_on_lineup ||
            String(match_lineups_by_pk.coach_steam_id) ===
              String(user.steam_id) ||
            isFinishedMatchAdmin),
        );
      }
      case ChatLobbyType.MatchMaking: {
        const { lobby_players_by_pk } = await this.hasuraService.query({
          lobby_players_by_pk: {
            __args: { lobby_id: id, steam_id: user.steam_id },
            status: true,
          },
        });
        return lobby_players_by_pk?.status === "Accepted";
      }
      case ChatLobbyType.Tournament:
        return this.canAccessTournamentChat(id, user.steam_id);
      case ChatLobbyType.Draft: {
        if (isRoleAbove(user.role, "match_organizer")) return true;
        const { draft_games } = await this.hasuraService.query({
          draft_games: {
            __args: {
              where: {
                id: { _eq: id },
                _or: [
                  { access: { _eq: "Open" } },
                  { host_steam_id: { _eq: user.steam_id } },
                  { players: { steam_id: { _eq: user.steam_id } } },
                ],
              },
            },
            id: true,
          },
        });
        return draft_games.length > 0;
      }
      case ChatLobbyType.Organizer:
        return isRoleAbove(user.role, "match_organizer");
      case ChatLobbyType.Global:
        return isRoleAbove(user.role, "verified_user");
      case ChatLobbyType.Direct: {
        const parties = id.split(":");
        if (parties.length !== 2 || !parties.includes(String(user.steam_id)))
          return false;
        const otherSteamId = parties.find(
          (steamId) => steamId !== String(user.steam_id),
        );
        if (!otherSteamId) return false;
        const { friends } = await this.hasuraService.query({
          friends: {
            __args: {
              where: {
                status: { _eq: "Accepted" },
                _or: [
                  {
                    player_steam_id: { _eq: user.steam_id },
                    other_player_steam_id: { _eq: otherSteamId },
                  },
                  {
                    player_steam_id: { _eq: otherSteamId },
                    other_player_steam_id: { _eq: user.steam_id },
                  },
                ],
              },
              limit: 1,
            },
            player_steam_id: true,
          },
        });
        return (
          friends.length > 0 &&
          !(await this.blocks.isBlockedEitherDirection(
            user.steam_id,
            otherSteamId,
          ))
        );
      }
      case ChatLobbyType.Announcement:
        return id === ANNOUNCEMENTS_LOBBY_ID;
      case ChatLobbyType.Team:
      default:
        return false;
    }
  }

  private async getCurrentUser(steamId: string): Promise<User | undefined> {
    const { players_by_pk } = await this.hasuraService.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        role: true,
        steam_id: true,
        country: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
        language: true,
        last_sign_in_at: true,
      },
    });

    if (!players_by_pk) {
      return;
    }

    return {
      ...players_by_pk,
      steam_id: String(players_by_pk.steam_id),
    } as User;
  }

  private async canSendDraftMessage(
    id: string,
    player: User,
  ): Promise<boolean> {
    if (isRoleAbove(player.role, "match_organizer")) {
      return true;
    }

    const steamId = player.steam_id;

    const { draft_games_by_pk } = await this.hasuraService.query({
      draft_games_by_pk: {
        __args: { id },
        status: true,
        match_id: true,
        host_steam_id: true,
        players: {
          steam_id: true,
          status: true,
          lineup: true,
        },
      },
    });

    if (!draft_games_by_pk) {
      return false;
    }

    const lobbyPhase =
      !draft_games_by_pk.match_id &&
      ["Open", "Filled"].includes(draft_games_by_pk.status);

    if (lobbyPhase) {
      return true;
    }

    if (String(draft_games_by_pk.host_steam_id) === String(steamId)) {
      return true;
    }

    // A waitlisted backup moved into a lineup plays in the match but keeps
    // their Waitlist status, so lineup membership counts too.
    return (draft_games_by_pk.players || []).some(
      (draftPlayer) =>
        String(draftPlayer.steam_id) === String(steamId) &&
        (draftPlayer.status === "Accepted" || draftPlayer.lineup != null),
    );
  }

  // Also the access gate for the tournament webcam room (TournamentCallService).
  public async canAccessTournamentChat(
    id: string,
    steamId: string,
  ): Promise<boolean> {
    const { tournaments } = await this.hasuraService.query(
      {
        tournaments: {
          __args: {
            where: {
              id: { _eq: id },
              _or: [
                { is_organizer: { _eq: true } },
                {
                  teams: {
                    _or: [
                      { owner_steam_id: { _eq: steamId } },
                      { roster: { player_steam_id: { _eq: steamId } } },
                    ],
                  },
                },
                {
                  individual_signups: {
                    player_steam_id: { _eq: steamId },
                    status: {
                      _in: ["Registered", "Waitlisted", "Assigned"],
                    },
                  },
                },
              ],
            },
          },
          id: true,
        },
      },
      steamId,
    );

    return tournaments.length > 0;
  }

  public async sendMessageToChat(
    type: ChatLobbyType,
    id: string,
    player: User,
    _message: string,
    skipCheck = false,
    clientId?: string,
    videoDraftId?: string,
    // "game" only ever comes from ChatMessageEvent.ts (a message relayed
    // in from the live CS2/CSS server's own chat) -- every other caller
    // is the normal website chat box. Stored on the message so the post-
    // match chat log can visibly tell the two apart (reported: an admin
    // reviewing Match-type chat couldn't tell whether a line was typed
    // in-game or on the DEAFCS site itself).
    source: "website" | "game" = "website",
  ): Promise<{
    accepted: boolean;
    tooLong?: boolean;
    muteStatus?: WebsiteChatMuteStatus;
    restrictionStatus?: WebsiteRestrictionStatus;
  }> {
    // Website text only -- game-relayed lines keep their existing path.
    if (source === "website" && isChatMessageTooLong(_message ?? "")) {
      return { accepted: false, tooLong: true };
    }

    let videoDraftSession: any;
    if (videoDraftId) {
      // Short Video is a standalone chat message. Its destination and author
      // must match the server-created draft, and retries use its stable id.
      if (_message.trim()) return { accepted: false };
      const rawSession = await this.redis.get(this.videoDraftKey(videoDraftId));
      if (!rawSession) return { accepted: false };
      videoDraftSession = JSON.parse(rawSession);
      if (
        videoDraftSession.ownerSteamId !== String(player.steam_id) ||
        videoDraftSession.type !== type ||
        videoDraftSession.roomId !== id
      )
        return { accepted: false };

      const existing = await this.findSentVideoMessage(
        videoDraftId,
        videoDraftSession,
      );
      if (existing) {
        if (videoDraftSession.state !== "sent") {
          const ttl = Number(videoDraftSession.messageTtlSeconds);
          if (Number.isFinite(ttl) && ttl > 0)
            await this.applyVideoMessageTtl(
              type,
              id,
              String(existing.id),
              String(existing.media.id),
              ttl,
            );
          await this.markVideoDraftSent(
            videoDraftId,
            videoDraftSession,
            String(existing.id),
          );
        }
        return { accepted: true };
      }
      if (videoDraftSession.state === "sent") return { accepted: true };
    }

    // verify they are in the lobby
    if (skipCheck === false) {
      const restrictionStatus = await this.websiteRestrictions.getStatus(
        player.steam_id,
      );
      if (restrictionStatus.active) {
        return { accepted: false, restrictionStatus };
      }

      const muteStatus = await this.getWebsiteChatMuteStatus(player.steam_id);
      if (muteStatus.active) {
        return { accepted: false, muteStatus };
      }

      if (
        type === ChatLobbyType.Tournament &&
        !(await this.canAccessTournamentChat(id, player.steam_id))
      ) {
        await this.removeUserData(type, id, player.steam_id);
        await this.redis.del(this.sessionsKey(type, id, player.steam_id));
        return { accepted: false };
      }

      const userData = await this.getUserData(type, id, player.steam_id);
      if (!userData) {
        return { accepted: false };
      }

      if (
        type === ChatLobbyType.Draft &&
        !(await this.canSendDraftMessage(id, player))
      ) {
        return { accepted: false };
      }

      // Closes the "already had the DM tab open" bypass: joinMatchLobby's
      // friends-only check only runs at join time, and blocking removes
      // the friendship row (see ti_v_my_blocks), but a tab opened *before*
      // the block never re-joins. Re-checked here on every send instead.
      if (type === ChatLobbyType.Direct) {
        const parties = id.split(":");
        const otherSteamId = parties.find((p) => p !== String(player.steam_id));
        if (
          otherSteamId &&
          (await this.blocks.isBlockedEitherDirection(
            player.steam_id,
            otherSteamId,
          ))
        ) {
          return { accepted: false };
        }
      }

      // Only admins can post an announcement -- everyone else can read
      // (checked in joinMatchLobby) but silently can't send, same
      // "silently ignored" convention as the checks above.
      if (
        type === ChatLobbyType.Announcement &&
        !isRoleAbove(player.role, "administrator")
      ) {
        return { accepted: false };
      }
    }

    const name = await this.redis.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(player.steam_id),
    );

    const role: e_player_roles_enum = (await this.redis.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(player.steam_id),
    )) as unknown as e_player_roles_enum;

    const messageTtlSeconds = this.getChatMessageTtlSeconds(type);
    const timestamp = new Date();
    const message: Record<string, unknown> = {
      message: _message,
      timestamp: timestamp.toISOString(),
      from: {
        role: name ? JSON.parse(role) : player.role,
        name: name ? JSON.parse(name) : player.name,
        steam_id: player.steam_id,
        avatar_url: player.avatar_url,
        profile_url: player.profile_url,
      },
      // Echoed straight back to every recipient (including the sender's
      // own other sessions) -- see chat.gateway.ts's comment on why this
      // is needed alongside from.steam_id.
      clientId,
      source,
    };

    let sentVideoMediaId: string | undefined;
    let sentVideoMessageField: string | undefined;
    let sentVideoTtlSeconds: number | undefined;
    if (videoDraftId) {
      const consumed = await this.consumeVideoDraft(
        videoDraftId,
        type,
        id,
        player,
        messageTtlSeconds,
      );
      if (!consumed) return { accepted: false };
      if (consumed.alreadySent) return { accepted: true };
      videoDraftSession = consumed.session;
      message.media = consumed.media;
      sentVideoMediaId = String(consumed.media.id);
      sentVideoMessageField = videoDraftId;
      sentVideoTtlSeconds = Number(consumed.session.messageTtlSeconds);
    }

    if (type === ChatLobbyType.Announcement) {
      // Persisted in Postgres instead of the Redis 24h-TTL hash below --
      // see ANNOUNCEMENTS_LOBBY_ID. `id` is the row's own uuid, the
      // stable handle editAnnouncement/deleteAnnouncement target.
      const rows = await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO public.announcements (author_steam_id, message)
         VALUES ($1, $2)
         RETURNING id`,
        [player.steam_id, _message],
      );
      message.id = rows[0].id;
    } else {
      const messageKey = `chat_${type}_${id}`;
      const messageField = sentVideoMessageField ?? uuidv4();
      message.id = messageField;
      if (sentVideoMediaId) {
        try {
          const inserted = await this.redis.hsetnx(
            messageKey,
            messageField,
            JSON.stringify(message),
          );
          if (Number(inserted) !== 1) {
            const existing = await this.findSentVideoMessage(
              videoDraftId!,
              videoDraftSession,
            );
            if (!existing) return { accepted: false };
            const ttl = Number(videoDraftSession.messageTtlSeconds);
            if (Number.isFinite(ttl) && ttl > 0)
              await this.applyVideoMessageTtl(
                type,
                id,
                String(existing.id),
                sentVideoMediaId,
                ttl,
              );
            await this.markVideoDraftSent(
              videoDraftId!,
              videoDraftSession,
              String(existing.id),
            );
            return { accepted: true };
          }
          await this.applyVideoMessageTtl(
            type,
            id,
            messageField,
            sentVideoMediaId,
            sentVideoTtlSeconds ?? messageTtlSeconds,
          );
          await this.markVideoDraftSent(
            videoDraftId!,
            videoDraftSession,
            messageField,
          );
        } catch (error) {
          const current = await this.redis
            .get(this.videoDraftKey(videoDraftId!))
            .catch((): null => null);
          const currentSession = current ? JSON.parse(current) : undefined;
          const persisted = currentSession
            ? await this.findSentVideoMessage(videoDraftId!, currentSession)
            : undefined;
          if (!persisted)
            await this.resetVideoDraftAfterFailedSend(videoDraftId!).catch(
              (): void => undefined,
            );
          throw error;
        }
      } else {
        await this.redis.hset(messageKey, messageField, JSON.stringify(message));
        await this.redis.sendCommand(
          new Redis.Command("HEXPIRE", [
            messageKey,
            messageTtlSeconds,
            "FIELDS",
            1,
            messageField,
          ]),
        );
      }
    }

    if (type === ChatLobbyType.Direct || type === ChatLobbyType.Announcement) {
      void this.to(type, id, "chat", message);
    } else {
      // Per-recipient redaction for live messages in shared rooms, mirroring
      // the history-load redaction above -- a viewer who has blocked the
      // sender gets a placeholder in real time too, not just on next join.
      void this.to(type, id, "chat", message, async (recipientSteamId) => {
        if (recipientSteamId === String(player.steam_id)) {
          return undefined;
        }
        const recipientBlockedSender = await this.blocks.hasBlocked(
          recipientSteamId,
          player.steam_id,
        );
        return recipientBlockedSender
          ? this.redactIfBlocked(message, new Set([String(player.steam_id)]))
          : undefined;
      });
    }

    // Best-effort push for anyone who's a member of this lobby but isn't
    // currently connected to it (getAllUsersInLobby only ever holds
    // people with an open socket to this exact channel -- i.e. already
    // seeing the message live, so they're excluded rather than targeted).
    // A failure here must never break message delivery, hence the catch.
    void this.notifyLobbyMembers(type, id, player, _message).catch((error) =>
      this.logger.warn(
        `[chat] push notify failed for ${type}:${id}: ${(error as Error)?.message}`,
      ),
    );

    return { accepted: true };
  }

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

  private async getDeletedMessageIds(type: ChatLobbyType, id: string) {
    const rows = await this.postgres.query<Array<{ message_id: string }>>(
      `SELECT message_id
         FROM public.chat_message_deletions
        WHERE room_type = $1 AND room_id = $2`,
      [type, id],
    );
    return new Set(rows.map((row) => row.message_id));
  }

  private async addReactionStateToMessages(
    messages: Array<Record<string, any>>,
    steamId: string,
  ) {
    if (!messages.length) return messages;

    const visible = messages.filter(
      (message) =>
        this.isUuid(String(message?.id ?? "")) && !message.blocked,
    );
    const reactionsByMessage = new Map<
      string,
      Array<{ reaction: ChatReactionId; count: number; reacted: boolean }>
    >();

    if (visible.length) {
      try {
        const pipeline = this.redis.pipeline();
        for (const message of visible) {
          for (const reaction of CHAT_REACTION_IDS) {
            const key = this.chatReactionKey(String(message.id), reaction);
            pipeline.scard(key);
            pipeline.sismember(key, String(steamId));
          }
        }

        const result = await pipeline.exec();
        let commandIndex = 0;
        for (const message of visible) {
          const reactions: Array<{
            reaction: ChatReactionId;
            count: number;
            reacted: boolean;
          }> = [];
          for (const reaction of CHAT_REACTION_IDS) {
            const [countError, countValue] = result?.[commandIndex++] ?? [];
            const [memberError, memberValue] = result?.[commandIndex++] ?? [];
            if (countError || memberError) continue;
            const count = Number(countValue);
            if (!Number.isFinite(count) || count <= 0) continue;
            reactions.push({
              reaction,
              count,
              reacted: Number(memberValue) === 1,
            });
          }
          reactionsByMessage.set(String(message.id), reactions);
        }
      } catch (error) {
        this.logger.warn(
          `[chat] unable to load message reactions: ${(error as Error)?.message}`,
        );
      }
    }

    return messages.map((message) => ({
      ...message,
      reactions:
        this.isUuid(String(message?.id ?? "")) && !message.blocked
          ? (reactionsByMessage.get(String(message.id)) ?? [])
          : [],
    }));
  }

  // Replaces a message's content with a placeholder when its sender is in
  // `blockedSteamIds` -- the message stays in the list (so ordering/count
  // for the viewer is undisturbed) but its text is never actually shown to
  // them. Does not touch the underlying stored content, so every other
  // viewer (and chat_message_deletions/admin audit) sees the real message.
  private redactIfBlocked(
    message: Record<string, any>,
    blockedSteamIds: Set<string>,
  ): Record<string, any> {
    const senderSteamId = String(message?.from?.steam_id ?? "");
    if (!blockedSteamIds.has(senderSteamId)) {
      return message;
    }
    return {
      ...message,
      message: "Message from blocked player",
      media: undefined,
      blocked: true,
    };
  }

  private readonly videoDraftTtlSeconds = 5 * 60;
  private readonly videoMediaTtlSeconds = 60 * 60 * 24;
  private readonly videoMaxBytes = 80 * 1024 * 1024;

  private videoTokenKey(token: string) {
    return `chat_video_token:${createHash("sha256").update(token).digest("hex")}`;
  }

  private videoDraftKey(id: string) {
    return `chat_video_draft:${id}`;
  }

  private videoMediaKey(id: string) {
    return `chat_video_media:${id}`;
  }

  public async createVideoDraftSession(
    type: ChatLobbyType,
    id: string,
    user: User,
  ) {
    if (
      type === ChatLobbyType.Announcement ||
      !Object.values(ChatLobbyType).includes(type)
    )
      return undefined;
    if ((await this.websiteRestrictions.getStatus(user.steam_id)).active)
      return undefined;
    if ((await this.getWebsiteChatMuteStatus(user.steam_id)).active)
      return undefined;
    if (
      type === ChatLobbyType.Tournament &&
      !(await this.canAccessTournamentChat(id, user.steam_id))
    )
      return undefined;
    if (!(await this.getUserData(type, id, user.steam_id))) return undefined;
    if (
      type === ChatLobbyType.Draft &&
      !(await this.canSendDraftMessage(id, user))
    )
      return undefined;
    if (type === ChatLobbyType.Direct) {
      const other = id
        .split(":")
        .find((steamId) => steamId !== String(user.steam_id));
      if (
        !other ||
        (await this.blocks.isBlockedEitherDirection(user.steam_id, other))
      )
        return undefined;
    }
    const activeKey = `chat_video_active:${String(user.steam_id)}`;
    const sessionId = uuidv4();
    if (
      !(await this.redis.set(
        activeKey,
        sessionId,
        "EX",
        this.videoDraftTtlSeconds,
        "NX",
      ))
    )
      return undefined;
    const token = randomBytes(32).toString("base64url");
    const session = {
      id: sessionId,
      ownerSteamId: String(user.steam_id),
      type,
      roomId: id,
      state: "recording",
      createdAt: Date.now(),
      tokenKey: this.videoTokenKey(token),
    };
    await this.redis.set(
      this.videoDraftKey(sessionId),
      JSON.stringify(session),
      "EX",
      this.videoDraftTtlSeconds,
    );
    await this.redis.set(
      this.videoTokenKey(token),
      sessionId,
      "EX",
      this.videoDraftTtlSeconds,
    );
    return {
      id: sessionId,
      token,
      expiresAt: new Date(
        Date.now() + this.videoDraftTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  public async getPhoneVideoDraft(token: string) {
    const tokenKey = this.videoTokenKey(token);
    const id = await this.redis.get(tokenKey);
    if (!id) return undefined;
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    if (session.tokenKey !== tokenKey) return undefined;
    if (
      session.state !== "sent" &&
      Date.now() >= session.createdAt + this.videoDraftTtlSeconds * 1000
    )
      return undefined;
    if (!["recording", "ready", "sending", "sent"].includes(session.state))
      return undefined;
    return {
      state: session.state,
      expiresAt: new Date(
        session.createdAt + this.videoDraftTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  public async sendOwnedVideoDraft(id: string, user: User) {
    return this.sendVideoDraftSession(id, String(user.steam_id));
  }

  public async sendPhoneVideoDraft(token: string) {
    const tokenKey = this.videoTokenKey(token);
    const id = await this.redis.get(tokenKey);
    if (!id) return { accepted: false };
    return this.sendVideoDraftSession(id, undefined, tokenKey);
  }

  private async sendVideoDraftSession(
    id: string,
    authenticatedSteamId?: string,
    tokenKey?: string,
  ) {
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return { accepted: false };
    const session = JSON.parse(raw);
    if (
      (authenticatedSteamId &&
        session.ownerSteamId !== authenticatedSteamId) ||
      (tokenKey && session.tokenKey !== tokenKey)
    )
      return { accepted: false };
    if (tokenKey && (await this.redis.get(tokenKey)) !== id)
      return { accepted: false };
    const existing = await this.findSentVideoMessage(id, session);
    if (existing) {
      if (session.state !== "sent") {
        const ttl = Number(session.messageTtlSeconds);
        if (Number.isFinite(ttl) && ttl > 0)
          await this.applyVideoMessageTtl(
            session.type,
            session.roomId,
            String(existing.id),
            String(existing.media.id),
            ttl,
          );
        await this.markVideoDraftSent(id, session, String(existing.id));
      }
      return { accepted: true };
    }
    if (session.state === "sent") return { accepted: true };
    if (
      !["ready", "sending"].includes(session.state) ||
      Date.now() >= session.createdAt + this.videoDraftTtlSeconds * 1000
    )
      return { accepted: false };

    // Resolve the account and current role from Hasura for both callers.
    // The phone's capability never supplies account identity or destination.
    const owner = await this.getCurrentUser(session.ownerSteamId);
    if (!owner) return { accepted: false };
    return this.sendMessageToChat(
      session.type,
      session.roomId,
      owner,
      "",
      false,
      undefined,
      id,
    );
  }

  public async retakeOwnedVideoDraft(id: string, user: User) {
    return this.resetVideoDraftForRetake(id, String(user.steam_id));
  }

  public async retakePhoneVideoDraft(token: string) {
    const tokenKey = this.videoTokenKey(token);
    const id = await this.redis.get(tokenKey);
    if (!id) return undefined;
    return this.resetVideoDraftForRetake(id, undefined, tokenKey);
  }

  private async resetVideoDraftForRetake(
    id: string,
    authenticatedSteamId?: string,
    tokenKey?: string,
  ) {
    const draftKey = this.videoDraftKey(id);
    const lockKey = "chat_video_claim:" + id;
    const raw = await this.redis.get(draftKey);
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    if (
      (authenticatedSteamId &&
        session.ownerSteamId !== authenticatedSteamId) ||
      (tokenKey && session.tokenKey !== tokenKey) ||
      (tokenKey && (await this.redis.get(tokenKey)) !== id)
    )
      return undefined;
    if (session.state === "sent") return { state: "sent" };
    if (Date.now() >= session.createdAt + this.videoDraftTtlSeconds * 1000)
      return { state: "expired" };
    if (!(await this.redis.set(lockKey, "retake", "EX", 120, "NX")))
      return undefined;

    let keepSentClaim = false;
    try {
      const latestRaw = await this.redis.get(draftKey);
      if (!latestRaw) return undefined;
      const latest = JSON.parse(latestRaw);
      if (
        (authenticatedSteamId &&
          latest.ownerSteamId !== authenticatedSteamId) ||
        (tokenKey && latest.tokenKey !== tokenKey) ||
        (tokenKey && (await this.redis.get(tokenKey)) !== id)
      )
        return undefined;
      if (latest.state === "sent") return { state: "sent" };
      if (
        Date.now() >= latest.createdAt + this.videoDraftTtlSeconds * 1000
      )
        return { state: "expired" };
      if (latest.state === "sending") {
        const existing = await this.findSentVideoMessage(id, latest);
        if (!existing) return undefined;
        await this.markVideoDraftSent(id, latest, String(existing.id));
        keepSentClaim = true;
        return { state: "sent" };
      }
      if (latest.state === "ready") {
        if (await this.redis.get("chat_video_upload_lock:" + id))
          return undefined;
        const existing = await this.findSentVideoMessage(id, latest);
        if (existing) {
          await this.markVideoDraftSent(id, latest, String(existing.id));
          keepSentClaim = true;
          return { state: "sent" };
        }
        if (latest.mediaId) await this.removeVideoMedia(latest.mediaId);
        await this.redis.del("chat_video_session_media:" + id);
      } else if (latest.state !== "recording") {
        return undefined;
      }

      const remaining = Math.ceil(
        (latest.createdAt + this.videoDraftTtlSeconds * 1000 - Date.now()) /
          1000,
      );
      if (remaining <= 0) return { state: "expired" };
      latest.state = "recording";
      delete latest.mediaId;
      delete latest.messageTtlSeconds;
      delete latest.sendStartedAt;
      await this.redis.set(draftKey, JSON.stringify(latest), "EX", remaining);
      if (latest.tokenKey)
        await this.redis.set(latest.tokenKey, id, "EX", remaining);
      return { state: "recording" };
    } finally {
      if (!keepSentClaim && (await this.redis.get(lockKey)) === "retake")
        await this.redis.del(lockKey);
    }
  }

  public async uploadPhoneVideoDraft(
    token: string,
    file: Buffer,
    claimedMimeType: string,
    durationMs: number,
  ) {
    const id = await this.redis.get(this.videoTokenKey(token));
    if (!id) return undefined;
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    return this.storeVideoDraft(id, session, file, claimedMimeType, durationMs);
  }

  public async uploadOwnedVideoDraft(
    id: string,
    user: User,
    file: Buffer,
    claimedMimeType: string,
    durationMs: number,
  ) {
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    if (session.ownerSteamId !== String(user.steam_id)) return undefined;
    return this.storeVideoDraft(id, session, file, claimedMimeType, durationMs);
  }

  private async storeVideoDraft(
    id: string,
    session: any,
    file: Buffer,
    claimedMimeType: string,
    durationMs: number,
  ) {
    if (
      session.state !== "recording" ||
      file.length === 0 ||
      file.length > this.videoMaxBytes ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > 60_000
    )
      return undefined;
    const mimeType = this.detectVideoMime(file.subarray(0, 16));
    if (
      !mimeType ||
      mimeType !== claimedMimeType.split(";")[0].trim().toLowerCase()
    )
      return undefined;
    const claimKey = `chat_video_claim:${id}`;
    if (!(await this.redis.set(claimKey, "uploading", "EX", 120, "NX")))
      return undefined;
    const lockKey = `chat_video_upload_lock:${id}`;
    if (!(await this.redis.set(lockKey, "1", "EX", 120, "NX"))) {
      await this.redis.del(claimKey);
      return undefined;
    }
    const mediaId = uuidv4();
    const objectKey = `chat-video/${mediaId}.${mimeType === "video/webm" ? "webm" : "mp4"}`;
    try {
      await this.s3.put(objectKey, file, mimeType);
      const media = {
        type: "video",
        id: mediaId,
        mimeType,
        durationMs: Math.round(durationMs),
        size: file.length,
      };
      await this.redis.set(
        this.videoMediaKey(mediaId),
        JSON.stringify({
          ...media,
          objectKey,
          ownerSteamId: session.ownerSteamId,
          chatType: session.type,
          roomId: session.roomId,
        }),
        "EX",
        this.videoMediaTtlSeconds,
      );
      await this.redis.set(
        `chat_video_session_media:${id}`,
        mediaId,
        "EX",
        this.videoMediaTtlSeconds,
      );
      session.state = "ready";
      session.mediaId = mediaId;
      const remaining = Math.max(
        1,
        Math.ceil(
          (session.createdAt + this.videoDraftTtlSeconds * 1000 - Date.now()) /
            1000,
        ),
      );
      await this.redis.set(
        this.videoDraftKey(id),
        JSON.stringify(session),
        "EX",
        remaining,
      );
      return { mediaId };
    } catch (error) {
      await this.s3.remove(objectKey).catch((): boolean => false);
      await this.redis.del(
        this.videoMediaKey(mediaId),
        `chat_video_session_media:${id}`,
      );
      throw error;
    } finally {
      await this.redis.del(lockKey);
      if ((await this.redis.get(claimKey)) === "uploading")
        await this.redis.del(claimKey);
    }
  }

  public async getOwnedVideoDraft(id: string, user: User) {
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    if (session.ownerSteamId !== String(user.steam_id)) return undefined;
    if (session.state === "ready") {
      const mediaRaw = await this.redis.get(
        this.videoMediaKey(session.mediaId),
      );
      if (!mediaRaw) return { state: "expired" };
      const media = JSON.parse(mediaRaw);
      return {
        state: "ready",
        media: {
          type: "video",
          id: media.id,
          mimeType: media.mimeType,
          durationMs: media.durationMs,
          size: media.size,
        },
      };
    }
    return { state: session.state };
  }

  public async cancelPhoneVideoDraft(token: string) {
    const tokenKey = this.videoTokenKey(token);
    const id = await this.redis.get(tokenKey);
    if (!id) return;
    if (await this.cancelVideoDraft(id)) await this.redis.del(tokenKey);
  }

  public async cancelOwnedVideoDraft(id: string, user: User) {
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return;
    const session = JSON.parse(raw);
    if (
      session.ownerSteamId !== String(user.steam_id) ||
      session.state === "sent"
    )
      return;
    await this.cancelVideoDraft(id);
  }

  private async cancelVideoDraft(id: string) {
    const draftKey = this.videoDraftKey(id);
    const claimKey = `chat_video_claim:${id}`;
    if (!(await this.redis.set(claimKey, "cancel", "EX", 120, "NX")))
      return false;
    try {
      const raw = await this.redis.get(draftKey);
      if (!raw) return true;
      const session = JSON.parse(raw);
      if (session.state === "sent") return false;
      const existing = await this.findSentVideoMessage(id, session);
      if (existing) {
        await this.markVideoDraftSent(id, session, String(existing.id));
        return false;
      }
      if (session.state === "sending") return false;
      if (session.mediaId) await this.removeVideoMedia(session.mediaId);
      if (session.tokenKey) await this.redis.del(session.tokenKey);
      await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
      await this.redis.del(draftKey, `chat_video_session_media:${id}`);
      return true;
    } finally {
      if ((await this.redis.get(claimKey)) === "cancel")
        await this.redis.del(claimKey);
    }
  }

  public async cleanupExpiredVideoDraft(id: string) {
    const draftKey = this.videoDraftKey(id);
    const raw = await this.redis.get(draftKey);
    if (raw) {
      const session = JSON.parse(raw);
      if (session.state === "sent") return;
      const claimKey = `chat_video_claim:${id}`;
      const claim = await this.redis.get(claimKey);
      const existing = await this.findSentVideoMessage(id, session);
      if (existing) {
        const ttl = Number(session.messageTtlSeconds);
        if (Number.isFinite(ttl) && ttl > 0)
          await this.applyVideoMessageTtl(
            session.type,
            session.roomId,
            String(existing.id),
            String(existing.media.id),
            ttl,
          );
        await this.markVideoDraftSent(id, session, String(existing.id));
        return;
      }
      if (claim) return;
      if (session.mediaId) await this.removeVideoMedia(session.mediaId);
      if (session.tokenKey) await this.redis.del(session.tokenKey);
      await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
      await this.redis.del(draftKey);
    } else {
      const claim = await this.redis.get(`chat_video_claim:${id}`);
      if (claim) return;
      const mediaId = await this.redis.get(`chat_video_session_media:${id}`);
      if (mediaId) await this.removeVideoMedia(mediaId);
    }
    await this.redis.del(`chat_video_session_media:${id}`);
  }

  private detectVideoMime(header: Buffer): string | undefined {
    if (
      header.length >= 4 &&
      header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    )
      return "video/webm";
    if (
      header.length >= 12 &&
      header.subarray(4, 8).toString("ascii") === "ftyp"
    )
      return "video/mp4";
    return undefined;
  }

  private async findSentVideoMessage(id: string, session: any) {
    if (!session.mediaId) return undefined;
    const messageKey = `chat_${session.type}_${session.roomId}`;
    const messageField = session.messageId || id;
    const raw = await this.redis.hget(messageKey, messageField);
    const candidates = raw ? [raw] : [];
    for (const value of candidates) {
      try {
        const message = JSON.parse(value as string);
        if (
          String(message?.media?.id) === String(session.mediaId) &&
          String(message?.from?.steam_id) === String(session.ownerSteamId)
        )
          return message;
      } catch {
        // Ignore malformed entries while looking for this exact attachment.
      }
    }
    // Older sent sessions used a random message id. Search only for those
    // legacy sessions, avoiding a full history scan on the normal send path.
    if (session.state === "sent" && !session.messageId) {
      const values = await this.redis.hgetall(messageKey);
      for (const value of Object.values(values)) {
        try {
          const message = JSON.parse(value as string);
          if (
            String(message?.media?.id) === String(session.mediaId) &&
            String(message?.from?.steam_id) === String(session.ownerSteamId)
          )
            return message;
        } catch {
          // Ignore malformed entries while searching legacy video messages.
        }
      }
    }
    return undefined;
  }

  private async applyVideoMessageTtl(
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
    mediaId: string,
    ttlSeconds: number,
  ) {
    const messageKey = `chat_${type}_${roomId}`;
    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        messageKey,
        ttlSeconds,
        "FIELDS",
        1,
        messageId,
      ]),
    );
    await this.redis.expire(this.videoMediaKey(mediaId), ttlSeconds);
  }

  private async scheduleSentVideoMediaCleanup(
    mediaId: string,
    objectKey: string,
    messageTtlSeconds: number,
  ) {
    const jobId = `chat-video-media-expiry-${mediaId}`;
    const delay = messageTtlSeconds * 1000 + 60 * 60 * 1000 + 1000;
    const existing = await this.chatVideoCleanupQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "delayed") {
        await existing.changeDelay(delay);
        return;
      }
      await existing.remove();
    }
    await this.chatVideoCleanupQueue.add(
      ExpireSentChatVideoMediaJobName,
      { mediaId, objectKey },
      {
        jobId,
        delay,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    );
  }

  private async markVideoDraftSent(
    id: string,
    session: any,
    messageId: string,
  ) {
    session.state = "sent";
    session.messageId = messageId;
    delete session.sendStartedAt;
    await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
    await this.redis.set(
      this.videoDraftKey(id),
      JSON.stringify(session),
      "EX",
      this.videoMediaTtlSeconds,
    );
    await this.redis.set(
      `chat_video_claim:${id}`,
      "sent",
      "EX",
      this.videoMediaTtlSeconds,
    );
  }

  private async resetVideoDraftAfterFailedSend(id: string) {
    const draftKey = this.videoDraftKey(id);
    const raw = await this.redis.get(draftKey);
    if (!raw) return;
    const session = JSON.parse(raw);
    if (session.state !== "sending") return;
    const remaining = Math.ceil(
      (session.createdAt + this.videoDraftTtlSeconds * 1000 - Date.now()) /
        1000,
    );
    if (remaining > 0) {
      session.state = "ready";
      delete session.messageTtlSeconds;
      delete session.sendStartedAt;
      await this.redis.set(draftKey, JSON.stringify(session), "EX", remaining);
    }
    if ((await this.redis.get(`chat_video_claim:${id}`)) === "sending")
      await this.redis.del(`chat_video_claim:${id}`);
  }

  private async waitForSentVideoMessage(id: string, session: any) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const latestRaw = await this.redis.get(this.videoDraftKey(id));
      const latest = latestRaw ? JSON.parse(latestRaw) : session;
      const existing = await this.findSentVideoMessage(id, latest);
      if (existing) return { session: latest, message: existing };
      if (latest.state === "sent") return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  private async consumeVideoDraft(
    id: string,
    type: ChatLobbyType,
    roomId: string,
    user: User,
    messageTtlSeconds = this.expiresIn,
  ) {
    const claimKey = `chat_video_claim:${id}`;
    const claimed = await this.redis.set(
      claimKey,
      "sending",
      "EX",
      120,
      "NX",
    );
    if (!claimed) {
      if ((await this.redis.get(claimKey)) !== "sending") return undefined;
      const rawSession = await this.redis.get(this.videoDraftKey(id));
      if (!rawSession) return undefined;
      const current = JSON.parse(rawSession);
      const complete = await this.waitForSentVideoMessage(id, current);
      if (complete) {
        const ttl = Number(complete.session.messageTtlSeconds);
        if (Number.isFinite(ttl) && ttl > 0)
          await this.applyVideoMessageTtl(
            type,
            roomId,
            String(complete.message.id),
            String(complete.message.media.id),
            ttl,
          );
        await this.markVideoDraftSent(
          id,
          complete.session,
          String(complete.message.id),
        );
        return { alreadySent: true };
      }
      return undefined;
    }
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) {
      await this.redis.del(claimKey);
      return undefined;
    }
    const session = JSON.parse(raw);
    if (
      !["ready", "sending"].includes(session.state) ||
      session.ownerSteamId !== String(user.steam_id) ||
      session.type !== type ||
      session.roomId !== roomId ||
      Date.now() >= session.createdAt + this.videoDraftTtlSeconds * 1000
    ) {
      await this.redis.del(claimKey);
      return undefined;
    }
    if (session.state === "sending") {
      const existing = await this.findSentVideoMessage(id, session);
      if (existing) {
        const ttl = Number(session.messageTtlSeconds);
        if (Number.isFinite(ttl) && ttl > 0)
          await this.applyVideoMessageTtl(
            type,
            roomId,
            String(existing.id),
            String(existing.media.id),
            ttl,
          );
        await this.markVideoDraftSent(id, session, String(existing.id));
        return { alreadySent: true };
      }
    }
    const rawMedia = await this.redis.get(this.videoMediaKey(session.mediaId));
    if (!rawMedia) {
      await this.redis.del(claimKey);
      return undefined;
    }
    const media = JSON.parse(rawMedia);
    if (
      media.ownerSteamId !== String(user.steam_id) ||
      media.roomId !== roomId ||
      media.chatType !== type
    ) {
      await this.redis.del(claimKey);
      return undefined;
    }
    const publicMedia = {
      type: media.type,
      id: media.id,
      mimeType: media.mimeType,
      durationMs: media.durationMs,
      size: media.size,
    };
    const ttl = Number(session.messageTtlSeconds) || messageTtlSeconds;
    session.messageTtlSeconds = ttl;
    session.state = "sending";
    session.sendStartedAt = Date.now();
    await this.redis.set(
      this.videoDraftKey(id),
      JSON.stringify(session),
      "EX",
      this.videoMediaTtlSeconds,
    );
    try {
      await this.scheduleSentVideoMediaCleanup(
        media.id,
        media.objectKey,
        ttl,
      );
    } catch (error) {
      this.logger.warn(
        `[chat-video] unable to schedule message-lifetime cleanup for ${media.id}`,
        error,
      );
      await this.resetVideoDraftAfterFailedSend(id);
      return undefined;
    }
    return { media: publicMedia, session };
  }

  public async cleanupExpiredSentVideoMedia(
    mediaId: string,
    objectKey: string,
  ) {
    const prefix = `chat-video/${mediaId}.`;
    const extension = objectKey.startsWith(prefix)
      ? objectKey.slice(prefix.length)
      : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        mediaId,
      ) ||
      !["webm", "mp4"].includes(extension)
    ) {
      throw new Error("invalid chat video cleanup target");
    }

    const removed = await this.s3.remove(objectKey);
    if (!removed && (await this.s3.has(objectKey))) {
      throw new Error(`unable to remove expired chat video ${mediaId}`);
    }
    await this.redis.del(this.videoMediaKey(mediaId));
  }

  public async getVideoMediaForViewer(mediaId: string, user: User) {
    const raw = await this.redis.get(this.videoMediaKey(mediaId));
    if (!raw) return undefined;
    const media = JSON.parse(raw);
    if (
      !(await this.getUserData(
        media.chatType,
        media.roomId,
        String(user.steam_id),
      ))
    )
      return undefined;
    const deletedIds = await this.getDeletedMessageIds(
      media.chatType,
      media.roomId,
    );
    const values = await this.redis.hgetall(
      `chat_${media.chatType}_${media.roomId}`,
    );
    const message = Object.values(values)
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .find(
        (candidate: any) =>
          candidate?.media?.id === mediaId &&
          !deletedIds.has(String(candidate.id)),
      );
    if (!message) return undefined;
    if (media.chatType === ChatLobbyType.Direct) {
      if (
        await this.blocks.isBlockedEitherDirection(
          user.steam_id,
          message.from?.steam_id,
        )
      )
        return undefined;
    } else if (
      (await this.blocks.getMyBlockedSteamIds(user.steam_id)).has(
        String(message.from?.steam_id),
      )
    )
      return undefined;
    return media;
  }

  public async removeVideoMedia(mediaId: string) {
    const raw = await this.redis.get(this.videoMediaKey(mediaId));
    if (raw) await this.s3.remove(JSON.parse(raw).objectKey);
    await this.redis.del(this.videoMediaKey(mediaId));
  }

  private formatAnnouncementRow(row: {
    id: string;
    message: string;
    created_at: string;
    author_steam_id: string;
    author_name: string | null;
    author_role: e_player_roles_enum;
    author_avatar_url: string | null;
    author_profile_url: string | null;
  }) {
    return {
      id: row.id,
      message: row.message,
      timestamp: new Date(row.created_at).toISOString(),
      from: {
        role: row.author_role,
        name: row.author_name,
        steam_id: row.author_steam_id,
        avatar_url: row.author_avatar_url,
        profile_url: row.author_profile_url,
      },
    };
  }

  private async getAnnouncementMessages() {
    const rows = await this.postgres.query<
      Array<{
        id: string;
        message: string;
        created_at: string;
        author_steam_id: string;
        author_name: string | null;
        author_role: e_player_roles_enum;
        author_avatar_url: string | null;
        author_profile_url: string | null;
      }>
    >(
      `SELECT a.id, a.message, a.created_at,
              p.steam_id::text AS author_steam_id,
              p.name AS author_name,
              p.role AS author_role,
              COALESCE(p.custom_avatar_url, p.avatar_url) AS author_avatar_url,
              p.profile_url AS author_profile_url
         FROM public.announcements a
         JOIN public.players p ON p.steam_id = a.author_steam_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.created_at DESC
        LIMIT 100`,
    );

    return rows.reverse().map((row) => this.formatAnnouncementRow(row));
  }

  private selfServiceCutoff(now = Date.now()) {
    return new Date(now - CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS);
  }

  private isWithinSelfServiceWindow(timestamp: unknown, now = Date.now()) {
    if (typeof timestamp !== "string" && !(timestamp instanceof Date)) {
      return false;
    }
    const createdAt = new Date(timestamp).getTime();
    if (Number.isNaN(createdAt)) return false;
    const age = now - createdAt;
    return (
      age >= -CHAT_MESSAGE_CLOCK_SKEW_MS &&
      age <= CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS
    );
  }

  // A stored Redis message the actor wrote on the website themselves,
  // still inside the self-service window. Game-relayed lines (source
  // "game") and anything without a real author never qualify, so no
  // ownership is ever inferred for automatic/system messages.
  private isOwnRecentWebsiteMessage(
    stored: Record<string, any>,
    messageId: string,
    actorSteamId: string,
  ) {
    return (
      String(stored?.id ?? "") === messageId &&
      Boolean(stored?.from?.steam_id) &&
      String(stored.from.steam_id) === String(actorSteamId) &&
      stored?.source === "website" &&
      this.isWithinSelfServiceWindow(stored?.timestamp)
    );
  }

  private normalizeEditedMessage(_message: unknown): string | undefined {
    if (typeof _message !== "string") return;
    const message = _message.trim();
    if (!message || isChatMessageTooLong(message)) return;
    return message;
  }

  // Author-only, within CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS of creation.
  // Posting announcements stays administrator-only, so editing does too,
  // but the administrator role grants no override over another author's
  // announcement. Re-checked here, never trusted from the caller.
  public async editAnnouncement(
    client: FiveStackWebSocketClient,
    id: string,
    _message: string,
  ): Promise<boolean> {
    const message = this.normalizeEditedMessage(_message);
    if (!message || !id || !this.isUuid(id)) return false;

    const actor = await this.refreshClientUser(client);
    if (!actor || !isRoleAbove(actor.role, "administrator")) return false;
    if ((await this.websiteRestrictions.getStatus(actor.steam_id)).active)
      return false;
    if ((await this.getWebsiteChatMuteStatus(actor.steam_id)).active)
      return false;
    if (
      !(await this.hasCurrentChatRoomAccess(
        client,
        ChatLobbyType.Announcement,
        ANNOUNCEMENTS_LOBBY_ID,
        actor,
      ))
    )
      return false;

    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.announcements
          SET message = $2, updated_at = now()
        WHERE id = $1::uuid
          AND deleted_at IS NULL
          AND author_steam_id = $3::bigint
          AND created_at >= $4::timestamptz
        RETURNING id`,
      [id, message, actor.steam_id, this.selfServiceCutoff().toISOString()],
    );

    if (!rows[0]) {
      return false;
    }

    void this.to(ChatLobbyType.Announcement, ANNOUNCEMENTS_LOBBY_ID, "edited", {
      id,
      message,
    });
    return true;
  }

  // Author-only edit of an ordinary Redis-backed website text message,
  // within CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS. Only the text changes: id,
  // timestamp, author, source and remaining TTL are preserved. This is a
  // website-history edit only -- it is never relayed to a game server and
  // creates no notification or new "chat" event.
  public async editChatMessage(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
    _message: string,
  ): Promise<boolean> {
    if (
      !roomId ||
      !messageId ||
      !Object.values(ChatLobbyType).includes(type) ||
      type === ChatLobbyType.Announcement
    ) {
      return false;
    }
    const message = this.normalizeEditedMessage(_message);
    if (!message) return false;

    const actor = await this.refreshClientUser(client);
    if (!actor) return false;
    if ((await this.websiteRestrictions.getStatus(actor.steam_id)).active)
      return false;
    // A muted player must not be able to "post" new content by editing.
    if ((await this.getWebsiteChatMuteStatus(actor.steam_id)).active)
      return false;
    if (!(await this.hasCurrentChatRoomAccess(client, type, roomId, actor)))
      return false;

    const messageKey = `chat_${type}_${roomId}`;
    const raw = await this.redis.hget(messageKey, messageId);
    if (!raw) return false;

    let stored: Record<string, any>;
    try {
      stored = JSON.parse(raw);
    } catch {
      return false;
    }

    if (
      !this.isOwnRecentWebsiteMessage(stored, messageId, actor.steam_id) ||
      typeof stored.message !== "string" ||
      !stored.message.trim() ||
      stored.media ||
      stored.blocked
    ) {
      return false;
    }

    if ((await this.getDeletedMessageIds(type, roomId)).has(messageId))
      return false;

    const updated = { ...stored, message };
    const result = (await this.redis.eval(
      CHAT_MESSAGE_EDIT_LUA,
      2,
      messageKey,
      this.chatReactionDeletedKey(messageId),
      messageId,
      raw,
      JSON.stringify(updated),
    )) as [number, number];
    if (Number(result?.[0]) !== 1) return false;

    const authorSteamId = String(stored.from.steam_id);
    const payload = { id: messageId, message };
    if (type === ChatLobbyType.Direct) {
      void this.to(type, roomId, "edited", payload);
    } else {
      // Same per-recipient redaction as a live "chat" event: a viewer who
      // blocked the author must not receive the new text via an edit.
      void this.to(
        type,
        roomId,
        "edited",
        payload,
        async (recipientSteamId) => {
          if (recipientSteamId === authorSteamId) return undefined;
          if (!(await this.blocks.hasBlocked(recipientSteamId, authorSteamId)))
            return undefined;
          const redacted = this.redactIfBlocked(
            updated,
            new Set([authorSteamId]),
          );
          return { id: messageId, message: redacted.message };
        },
      );
    }
    return true;
  }

  // Delete policy (re-checked here, never trusted from the caller):
  //  - the author may delete their own website message within
  //    CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS, while still in the room
  //    (allowed even while website-chat-muted: removal posts nothing new);
  //  - an administrator may delete any auditable message at any age for
  //    moderation, with the same reach as before.
  // Both paths write the same chat_message_deletions audit row, recording
  // who deleted it.
  public async deleteMessage(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
  ): Promise<boolean> {
    if (!roomId || !messageId || !Object.values(ChatLobbyType).includes(type)) {
      return false;
    }

    const currentActor = await this.refreshClientUser(client);
    if (!currentActor) {
      return false;
    }

    if (
      (await this.websiteRestrictions.getStatus(currentActor.steam_id)).active
    ) {
      return false;
    }

    const isAdministrator = isRoleAbove(currentActor.role, "administrator");
    if (
      !isAdministrator &&
      !(await this.hasCurrentChatRoomAccess(client, type, roomId, currentActor))
    ) {
      return false;
    }

    let audited = false;
    if (type === ChatLobbyType.Announcement) {
      if (roomId !== ANNOUNCEMENTS_LOBBY_ID || !this.isUuid(messageId)) {
        return false;
      }
      const rows = await this.postgres.query<Array<{ message_id: string }>>(
        `WITH target AS (
           UPDATE public.announcements
              SET deleted_at = now(), deleted_by_steam_id = $2::bigint
            WHERE id = $1::uuid AND deleted_at IS NULL
              AND (
                $4::boolean
                OR (author_steam_id = $2::bigint
                    AND created_at >= $5::timestamptz)
              )
            RETURNING id, author_steam_id, message, created_at, deleted_at
         )
         INSERT INTO public.chat_message_deletions (
           message_id, room_type, room_id, author_steam_id, message,
           message_created_at, deleted_at, deleted_by_steam_id
         )
         SELECT id::text, 'announcement', $3, author_steam_id, message,
                created_at, deleted_at, $2::bigint
           FROM target
         ON CONFLICT (room_type, room_id, message_id) DO NOTHING
         RETURNING message_id`,
        [
          messageId,
          currentActor.steam_id,
          roomId,
          isAdministrator,
          this.selfServiceCutoff().toISOString(),
        ],
      );
      audited = rows.length > 0;
      if (audited) {
        try {
          await this.clearChatMessageReactions(messageId);
        } catch (error) {
          this.logger.warn(
            `[chat] unable to remove announcement reactions ${messageId}`,
            error,
          );
        }
      }
    } else {
      const messageKey = `chat_${type}_${roomId}`;
      const raw = await this.redis.hget(messageKey, messageId);
      if (!raw) {
        return false;
      }

      let stored: any;
      try {
        stored = JSON.parse(raw);
      } catch {
        this.logger.warn(
          `[chat] refusing to delete malformed stored message ${type}:${roomId}:${messageId}`,
        );
        return false;
      }

      if (
        !stored?.from?.steam_id ||
        typeof stored?.message !== "string" ||
        !stored?.timestamp ||
        Number.isNaN(new Date(stored.timestamp).getTime())
      ) {
        this.logger.warn(
          `[chat] refusing to delete incomplete stored message ${type}:${roomId}:${messageId}`,
        );
        return false;
      }

      if (
        !isAdministrator &&
        !this.isOwnRecentWebsiteMessage(
          stored,
          messageId,
          currentActor.steam_id,
        )
      ) {
        return false;
      }

      const rows = await this.postgres.query<Array<{ message_id: string }>>(
        `INSERT INTO public.chat_message_deletions (
           message_id, room_type, room_id, author_steam_id, message,
           message_created_at, deleted_by_steam_id
         ) VALUES ($1, $2, $3, $4::bigint, $5, $6::timestamptz, $7::bigint)
         ON CONFLICT (room_type, room_id, message_id) DO NOTHING
         RETURNING message_id`,
        [
          messageId,
          type,
          roomId,
          String(stored.from.steam_id),
          stored.message,
          stored.timestamp,
          currentActor.steam_id,
        ],
      );
      audited = rows.length > 0;

      if (audited) {
        try {
          await this.clearChatMessageReactions(messageId);
        } catch (error) {
          this.logger.warn(
            `[chat] unable to remove reactions for deleted message ${type}:${roomId}:${messageId}`,
            error,
          );
        }
        if (stored.media?.id) {
          try {
            await this.removeVideoMedia(String(stored.media.id));
          } catch (error) {
            this.logger.warn(
              `[chat] unable to remove deleted video ${stored.media.id}`,
              error,
            );
          }
        }
        try {
          await this.redis.hdel(messageKey, messageId);
        } catch (error) {
          // The durable audit marker above is also consulted on history load,
          // so the content remains hidden even if Redis deletion is transiently
          // unavailable. Live viewers still receive the deletion broadcast.
          this.logger.warn(
            `[chat] unable to remove audited Redis message ${type}:${roomId}:${messageId}`,
            error,
          );
        }
      }
    }

    if (!audited) {
      return false;
    }

    void this.to(type, roomId, "deleted", { id: messageId });
    return true;
  }

  // Deliberately does NOT try to exclude members who are "present" --
  // getAllUsersInLobby tracks whether a client is connected to this lobby
  // at all (tied to the chat widget's mount lifecycle), not whether
  // someone actually has eyes on this specific message right now. On
  // match/tournament pages the lobby connection can outlive the chat
  // panel being open, which silently suppressed push for anyone who'd
  // merely visited the page earlier. Always notifying every other member
  // costs an occasional redundant push while actively chatting, which is
  // a far smaller problem than never notifying at all.
  // Human-readable channel label prefixed onto the notification title
  // (e.g. "[GLOBAL CHAT] Theft") so a push/bell notification says which
  // chat it's from -- Direct (1:1 DMs) deliberately has no entry, so the
  // title stays just the sender's name there, matching how a private
  // message app would show it.
  private static readonly CHAT_LABELS: Partial<Record<ChatLobbyType, string>> =
    {
      [ChatLobbyType.Global]: "GLOBAL CHAT",
      [ChatLobbyType.Organizer]: "ORGANIZER",
      [ChatLobbyType.MatchMaking]: "LOBBY",
      [ChatLobbyType.Draft]: "DRAFT",
      [ChatLobbyType.Tournament]: "TOURNAMENT",
      [ChatLobbyType.Match]: "MATCH",
      [ChatLobbyType.MatchTeam]: "TEAM",
      [ChatLobbyType.Announcement]: "ANNOUNCEMENT",
    };

  private notificationTitle(
    type: ChatLobbyType,
    senderName: string | null | undefined,
  ): string {
    const name = senderName || "Someone";
    const label = ChatService.CHAT_LABELS[type];
    return label ? `[${label}] ${name}` : name;
  }

  private async notifyLobbyMembers(
    type: ChatLobbyType,
    id: string,
    sender: User,
    message: string,
  ): Promise<void> {
    // Global has no fixed roster (every verified_user+ player is a
    // "member") -- targeting each of them individually via notifyPlayers
    // wouldn't scale and would defeat the point of push preferences being
    // opt-in for this specific channel. Use the same role-broadcast path
    // tournament-created notifications use instead: one row, resolved to
    // recipients at send time by handleNotificationInsert.
    if (type === ChatLobbyType.Global) {
      await this.notifications.sendSilent(
        "GlobalChatMessage" as unknown as e_notification_types_enum,
        {
          title: this.notificationTitle(type, sender.name),
          message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
          role: "verified_user" as e_player_roles_enum,
          entity_id: `${type}:${id}`,
          excludeSteamId: sender.steam_id,
        },
      );

      // Same "chicken-and-egg" fix as Announcement below: the live to()
      // broadcast only reaches sockets with an active listener registered
      // for this lobby, which (unlike joining, which happens automatically
      // for every logged-in player -- see useChatTabSetup) requires
      // <ChatLobby> to have actually mounted at least once this session,
      // i.e. the chat hub panel having been opened. Without this, Global
      // Chat's unread badge silently never appeared for anyone who hadn't
      // opened chat yet this session (reported: no red badge until you
      // manually open chat once).
      await this.pingRoleBroadcastFallback(
        type,
        id,
        sender,
        message,
        "verified_user",
      );
      return;
    }

    // Announcements have the same "no fixed roster" shape as Global --
    // every logged-in player, including the base "user" role, can read
    // them (see joinMatchLobby's Announcement case), so notify by role
    // rather than a fixed roster. "user" is the lowest role in
    // roleOrder (see isRoleAbove), so this reaches literally everyone.
    if (type === ChatLobbyType.Announcement) {
      await this.notifications.sendSilent(
        "AnnouncementChatMessage" as unknown as e_notification_types_enum,
        {
          title: this.notificationTitle(type, sender.name),
          message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
          role: "user" as e_player_roles_enum,
          entity_id: `${type}:${id}`,
          excludeSteamId: sender.steam_id,
        },
      );

      // Same "chicken-and-egg" fix as the generic path below: the live
      // to() broadcast above only reaches sockets that have a listener
      // registered for this lobby, which (unlike joining, which happens
      // automatically for every logged-in player -- see useChatTabSetup)
      // requires <ChatLobby> to have actually mounted at least once this
      // session, i.e. the chat hub panel having been opened. Without
      // this, the unread badge silently never appeared for anyone who
      // hadn't opened chat yet. No fixed roster to pull "everyone" from
      // here, so this pings literally every registered player.
      await this.pingRoleBroadcastFallback(type, id, sender, message, "user");
      return;
    }

    // Organizer chat has the same "no fixed roster, role-gated instead"
    // shape as Global (see joinMatchLobby's Organizer case, gated on
    // isRoleAbove(user.role, "match_organizer")) -- getLobbyMemberSteamIds
    // below has no case for it and always returns [], so without this
    // early branch notifyLobbyMembers would silently bail at the
    // `!members.length` check right after and never actually notify
    // anyone. This is why OrganizerChatMessage push never fired at all
    // previously, not just why it lacked its own toggle.
    if (type === ChatLobbyType.Organizer) {
      await this.notifications.sendSilent(
        "OrganizerChatMessage" as unknown as e_notification_types_enum,
        {
          title: this.notificationTitle(type, sender.name),
          message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
          role: "match_organizer" as e_player_roles_enum,
          entity_id: `${type}:${id}`,
          excludeSteamId: sender.steam_id,
        },
      );

      // Same chicken-and-egg fix as Global/Announcement above -- see
      // those comments for the full explanation.
      await this.pingRoleBroadcastFallback(
        type,
        id,
        sender,
        message,
        "match_organizer",
      );
      return;
    }

    // Live match all-chat and team-chat are high-volume by nature (every
    // in-game say/say_team gets relayed here) and players are expected to
    // have the match page open while playing, so push notifications and
    // the unread badge fallback ping just add distracting noise during a
    // live match rather than surfacing something missed.
    if (type === ChatLobbyType.Match || type === ChatLobbyType.MatchTeam) {
      return;
    }

    const members = await this.getLobbyMemberSteamIds(type, id);
    if (!members.length) return;

    const senderId = String(sender.steam_id);
    const candidates = members.filter((steamId) => steamId !== senderId);
    if (!candidates.length) return;

    // No personal push notification from a blocked player -- covers DMs
    // and every fixed-roster room (Match/Team/Tournament/...) this
    // function's default path serves. Global/Announcement/Organizer use
    // their own role-broadcast branches above and are out of scope here.
    const blockingViewers = await this.blocks.getViewersBlocking(
      candidates,
      senderId,
    );
    const targets = candidates.filter(
      (steamId) => !blockingViewers.has(steamId),
    );

    if (!targets.length) return;

    // Match and MatchTeam are handled by their own early-return above and
    // never reach here anymore, so this is just the remaining lobby chats
    // (matchmaking queue, draft, tournament, team, direct). (Organizer
    // chat is handled in its own early-return branch above, not here.)
    await this.notifications.notifyPlayers(
      "ChatMessage" as unknown as e_notification_types_enum,
      {
        title: this.notificationTitle(type, sender.name),
        message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
        role: "user" as e_player_roles_enum,
        entity_id: `${type}:${id}`,
        steamIds: targets,
      },
    );

    // Reported bug: a brand-new incoming DM (or any first message in a
    // chat the recipient has never opened a tab for) produced no unread
    // indicator anywhere -- the only realtime delivery path is to()
    // above, which is scoped to sockets that have actually joined this
    // lobby's room, something a recipient can only do by opening the
    // conversation first. That's a chicken-and-egg problem: they had no
    // reason to open it since nothing told them a message arrived.
    // Ride the same steamId-addressed pub/sub channel to() uses, but
    // targeted at every recipient regardless of lobby membership, so the
    // frontend can register/update the tab and its unread badge even
    // when it was never joined. Deliberately sent to everyone in
    // `targets` (not just the ones missing from the lobby) -- the
    // frontend already knows how to no-op this for a tab it currently
    // has visibly open (see handleMessageReceived's isVisible check).
    for (const steamId of targets) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: "chat:new-message",
          data: {
            type,
            id,
            senderSteamId: sender.steam_id,
            senderName: sender.name,
            senderAvatarUrl: sender.avatar_url,
            message:
              message.length > 200 ? `${message.slice(0, 200)}…` : message,
          },
        }),
      );
    }
  }

  // Shared by every role-broadcast chat type (Global, Announcement,
  // Organizer): the live to() room broadcast in notifyLobbyMembers only
  // reaches sockets with an active per-lobby listener, which requires
  // <ChatLobby> to have actually mounted at least once this session (the
  // chat hub panel having been opened) -- see the callers' comments for
  // the full "chicken-and-egg" explanation. This pings every player at or
  // above `minRole` on the same steamId-addressed channel the fixed-roster
  // path below uses, so the frontend can update the tab/unread badge even
  // when it was never joined.
  private async pingRoleBroadcastFallback(
    type: ChatLobbyType,
    id: string,
    sender: User,
    message: string,
    minRole: e_player_roles_enum,
  ): Promise<void> {
    const senderId = String(sender.steam_id);
    const { players: rolePlayers } = await this.hasuraService.query({
      players: { steam_id: true, role: true },
    });
    for (const player of rolePlayers ?? []) {
      const steamId = String(player.steam_id);
      if (steamId === senderId) continue;
      if (!isRoleAbove(player.role, minRole)) continue;
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: "chat:new-message",
          data: {
            type,
            id,
            senderSteamId: sender.steam_id,
            senderName: sender.name,
            senderAvatarUrl: sender.avatar_url,
            message:
              message.length > 200 ? `${message.slice(0, 200)}…` : message,
          },
        }),
      );
    }
  }

  // Resolves the fixed member roster for a lobby (distinct from
  // getAllUsersInLobby, which only tracks who's currently connected) so
  // push notifications can reach people who are members but not actively
  // viewing this chat right now. Mirrors joinMatchLobby's membership
  // checks above, but returns the whole roster instead of validating one
  // user against it.
  private async getLobbyMemberSteamIds(
    type: ChatLobbyType,
    id: string,
  ): Promise<string[]> {
    switch (type) {
      case ChatLobbyType.Match: {
        const { matches_by_pk } = await this.hasuraService.query({
          matches_by_pk: {
            __args: { id },
            organizer_steam_id: true,
            lineup_1: {
              coach_steam_id: true,
              lineup_players: { steam_id: true },
            },
            lineup_2: {
              coach_steam_id: true,
              lineup_players: { steam_id: true },
            },
          },
        });
        if (!matches_by_pk) return [];

        const ids = new Set<string>();
        if (matches_by_pk.organizer_steam_id) {
          ids.add(String(matches_by_pk.organizer_steam_id));
        }
        for (const lineup of [matches_by_pk.lineup_1, matches_by_pk.lineup_2]) {
          if (!lineup) continue;
          if (lineup.coach_steam_id) ids.add(String(lineup.coach_steam_id));
          for (const lp of lineup.lineup_players ?? []) {
            ids.add(String(lp.steam_id));
          }
        }
        return [...ids];
      }
      case ChatLobbyType.MatchTeam: {
        const [, lineupId] = id.split(":");
        if (!lineupId) return [];

        const { match_lineups_by_pk } = await this.hasuraService.query({
          match_lineups_by_pk: {
            __args: { id: lineupId },
            coach_steam_id: true,
            lineup_players: { steam_id: true },
          },
        });
        if (!match_lineups_by_pk) return [];

        const ids = new Set<string>();
        if (match_lineups_by_pk.coach_steam_id) {
          ids.add(String(match_lineups_by_pk.coach_steam_id));
        }
        for (const lp of match_lineups_by_pk.lineup_players ?? []) {
          ids.add(String(lp.steam_id));
        }
        return [...ids];
      }
      case ChatLobbyType.MatchMaking: {
        const { lobby_players } = await this.hasuraService.query({
          lobby_players: {
            __args: {
              where: {
                lobby_id: { _eq: id },
                status: { _eq: "Accepted" },
              },
            },
            steam_id: true,
          },
        });
        return (lobby_players ?? []).map((p) => String(p.steam_id));
      }
      case ChatLobbyType.Tournament: {
        const {
          tournament_team_roster,
          tournament_individual_signups,
          tournament_teams,
          tournaments_by_pk,
        } = await this.hasuraService.query({
          tournament_team_roster: {
            __args: { where: { tournament_id: { _eq: id } } },
            player_steam_id: true,
          },
          tournament_individual_signups: {
            __args: {
              where: {
                tournament_id: { _eq: id },
                status: {
                  _in: ["Registered", "Waitlisted", "Assigned"],
                },
              },
            },
            player_steam_id: true,
          },
          tournament_teams: {
            __args: { where: { tournament_id: { _eq: id } } },
            owner_steam_id: true,
          },
          tournaments_by_pk: {
            __args: { id },
            organizer_steam_id: true,
            organizers: { steam_id: true },
          },
        });

        const ids = new Set<string>();
        for (const roster of tournament_team_roster ?? []) {
          ids.add(String(roster.player_steam_id));
        }
        for (const signup of tournament_individual_signups ?? []) {
          ids.add(String(signup.player_steam_id));
        }
        for (const team of tournament_teams ?? []) {
          if (team.owner_steam_id) {
            ids.add(String(team.owner_steam_id));
          }
        }
        if (tournaments_by_pk?.organizer_steam_id) {
          ids.add(String(tournaments_by_pk.organizer_steam_id));
        }
        for (const organizer of tournaments_by_pk?.organizers ?? []) {
          ids.add(String(organizer.steam_id));
        }
        return [...ids];
      }
      case ChatLobbyType.Draft: {
        const { draft_games_by_pk } = await this.hasuraService.query({
          draft_games_by_pk: {
            __args: { id },
            host_steam_id: true,
            players: { steam_id: true },
          },
        });
        if (!draft_games_by_pk) return [];

        const ids = new Set<string>();
        if (draft_games_by_pk.host_steam_id) {
          ids.add(String(draft_games_by_pk.host_steam_id));
        }
        for (const p of draft_games_by_pk.players ?? []) {
          ids.add(String(p.steam_id));
        }
        return [...ids];
      }
      case ChatLobbyType.Direct: {
        const parties = id.split(":");
        return parties.length === 2 ? parties : [];
      }
      default:
        // Organizer chat has dynamic, role-based membership rather than a
        // fixed roster, and Team isn't a reachable channel at all today
        // (joinMatchLobby's switch has no case for it) -- both
        // intentionally get no push recipients here.
        return [];
    }
  }

  public async to(
    type: ChatLobbyType,
    id: string,
    event:
      | "chat"
      | "list"
      | "messages"
      | "joined"
      | "left"
      // Optional lobby webcam call (see LobbyCallService) -- distinct
      // from "joined"/"left" above, which are chat-presence events.
      // "call-joining" fires as soon as someone starts the join flow
      // (token minted, before their camera is actually live) so the
      // people already in the call can show a "waiting for camera…"
      // placeholder instead of nothing.
      | "call-joined"
      | "call-left"
      | "call-joining"
      // An already-delivered message was edited or removed (see
      // editAnnouncement/editChatMessage/deleteMessage).
      | "edited"
      | "deleted"
      | "reaction",
    data: Record<string, any>,
    // Optional per-recipient override -- used only for live "chat" events
    // on shared rooms, so a viewer who blocked the sender gets a redacted
    // payload instead of the real message while everyone else in the same
    // loop still gets `data` unchanged. Returning undefined falls back to
    // `data` for that recipient.
    redactForRecipient?: (
      steamId: string,
    ) => Promise<Record<string, any> | undefined>,
  ) {
    const users = await this.getAllUsersInLobby(type, id);
    const eventName = `lobby:${type}:${id}:${event}`;

    for (const { steamId } of users) {
      if (
        type === ChatLobbyType.Tournament &&
        !(await this.canAccessTournamentChat(id, String(steamId)))
      ) {
        await this.removeUserData(type, id, steamId);
        await this.redis.del(this.sessionsKey(type, id, steamId));
        continue;
      }

      const payload = redactForRecipient
        ? ((await redactForRecipient(String(steamId))) ?? data)
        : data;

      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: eventName,
          data: payload,
        }),
      );
    }
  }

  public async removeFromLobby(
    type: ChatLobbyType,
    id: string,
    client: FiveStackWebSocketClient,
  ) {
    const userData = await this.getUserData(type, id, client.user.steam_id);
    if (!userData) {
      return;
    }

    const [removed, count] = await this.removeSession(
      type,
      id,
      client.user.steam_id,
      client.id,
    );

    if (removed === 1 && count === 0) {
      await this.removeUserData(type, id, client.user.steam_id);
      void this.to(type, id, "left", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    if (removed === 1 && userData.inGame) {
      void this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }
  }

  public async sendChatToServer(matchId: string, message: string) {
    try {
      const { matches_by_pk } = await this.hasuraService.query({
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          status: true,
          server: {
            id: true,
            plugin_runtime: true,
          },
        },
      });

      const server = matches_by_pk?.server;

      if (!server) {
        return;
      }

      if (matches_by_pk.status !== "Live") {
        return;
      }

      const rcon = await this.rcon.connect(server.id);
      if (!rcon) {
        return;
      }

      const command =
        server.plugin_runtime === "counterstrikesharp"
          ? "css_web_chat"
          : "sw_web_chat";

      return await rcon.send(`${command} "${message}"`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send match to server`,
        error.message,
      );
    }
  }

  public async joinLobbyViaGame(matchId: string, steamId: string) {
    const { players_by_pk: player } = await this.hasuraService.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        role: true,
        steam_id: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    const userData = await this.addUserToLobby(
      ChatLobbyType.Match,
      matchId,
      player,
      true,
    );

    void this.to(ChatLobbyType.Match, matchId, "joined", {
      user: {
        ...userData.user,
        inGame: userData.inGame,
      },
    });
  }

  public async leaveLobbyViaGame(matchId: string, steamId: string) {
    const userData = await this.getUserData(
      ChatLobbyType.Match,
      matchId,
      steamId,
    );
    if (!userData) {
      return;
    }

    userData.inGame = false;
    await this.setUserData(ChatLobbyType.Match, matchId, steamId, userData);

    const sessionCount = await this.redis.scard(
      this.sessionsKey(ChatLobbyType.Match, matchId, steamId),
    );
    if (sessionCount > 0) {
      void this.to(ChatLobbyType.Match, matchId, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    await this.removeUserData(ChatLobbyType.Match, matchId, steamId);

    void this.to(ChatLobbyType.Match, matchId, "left", {
      user: {
        steam_id: steamId,
      },
    });
  }

  private async addUserToLobby(
    type: ChatLobbyType,
    id: string,
    user: User,
    game: boolean,
  ) {
    let userData = await this.getUserData(type, id, user.steam_id);

    if (!userData) {
      userData = {
        user,
      };
    }

    if (game) {
      userData.inGame = true;
    }

    await this.setUserData(type, id, user.steam_id, userData);

    return userData;
  }

  private getLobbyKey(type: ChatLobbyType, id: string): string {
    return `chat:${type}:${id}`;
  }

  private sessionsKey(
    type: ChatLobbyType,
    id: string,
    steamId: string,
  ): string {
    return `${this.getLobbyKey(type, id)}:sessions:${steamId}`;
  }

  private async addSession(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    clientId: string,
  ): Promise<[number, number]> {
    const result = (await this.redis.eval(
      `local added = redis.call('SADD', KEYS[1], ARGV[1])
       redis.call('EXPIRE', KEYS[1], ARGV[2])
       return {added, redis.call('SCARD', KEYS[1])}`,
      1,
      this.sessionsKey(type, id, steamId),
      clientId,
      60 * 60 * 24,
    )) as [number, number];
    return result;
  }

  private async removeSession(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    clientId: string,
  ): Promise<[number, number]> {
    const result = (await this.redis.eval(
      `local removed = redis.call('SREM', KEYS[1], ARGV[1])
       return {removed, redis.call('SCARD', KEYS[1])}`,
      1,
      this.sessionsKey(type, id, steamId),
      clientId,
    )) as [number, number];
    return result;
  }

  private async getUserData(type: ChatLobbyType, id: string, steamId: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const userData = await this.redis.hget(lobbyKey, steamId);
    return userData ? JSON.parse(userData) : null;
  }

  private async clearChatMessageReactions(messageId: string) {
    const keys = [
      this.chatReactionDeletedKey(messageId),
      ...CHAT_REACTION_IDS.map((reaction) =>
        this.chatReactionKey(messageId, reaction),
      ),
    ];
    await this.redis.eval(
      CHAT_REACTION_DELETE_LUA,
      keys.length,
      ...keys,
      60 * 60 * 24,
    );
  }

  private async expireChatMessageReactions(
    messageId: string,
    ttlSeconds: number,
  ) {
    const pipeline = this.redis.pipeline();
    for (const reaction of CHAT_REACTION_IDS) {
      pipeline.expire(this.chatReactionKey(messageId, reaction), ttlSeconds);
    }
    await pipeline.exec();
  }

  private async setUserData(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    data: any,
  ) {
    const lobbyKey = this.getLobbyKey(type, id);
    await this.redis.hset(lobbyKey, steamId, JSON.stringify(data));
    await this.redis.expire(lobbyKey, 60 * 60 * 24);
  }

  private async removeUserData(
    type: ChatLobbyType,
    id: string,
    steamId: string,
  ) {
    const lobbyKey = this.getLobbyKey(type, id);
    await this.redis.hdel(lobbyKey, steamId);
  }

  private async getAllUsersInLobby(type: ChatLobbyType, id: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const users = await this.redis.hgetall(lobbyKey);
    return Object.entries(users).map(([steamId, data]) => ({
      steamId,
      ...JSON.parse(data),
    }));
  }

  public async removeLobby(type: ChatLobbyType, id: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const sessionKeys = await this.redis.keys(`${lobbyKey}:sessions:*`);
    await this.redis.del(lobbyKey, ...sessionKeys);
  }

  public async migrateLobbyMessages(
    fromType: ChatLobbyType,
    fromId: string,
    toType: ChatLobbyType,
    toId: string,
  ) {
    const fromKey = `chat_${fromType}_${fromId}`;
    const toKey = `chat_${toType}_${toId}`;
    const messageTtlSeconds = this.getChatMessageTtlSeconds(toType);

    const messagesObject = await this.redis.hgetall(fromKey);

    for (const [field, message] of Object.entries(messagesObject)) {
      await this.redis.hset(toKey, field, message);
      await this.redis.sendCommand(
        new Redis.Command("HEXPIRE", [
          toKey,
          messageTtlSeconds,
          "FIELDS",
          1,
          field,
        ]),
      );
      await this.expireChatMessageReactions(field, messageTtlSeconds);

      const parsed = JSON.parse(message);
      if (parsed.media?.type === "video" && parsed.media.id) {
        const mediaKey = this.videoMediaKey(String(parsed.media.id));
        const rawMedia = await this.redis.get(mediaKey);
        if (rawMedia) {
          const media = JSON.parse(rawMedia);
          await this.scheduleSentVideoMediaCleanup(
            String(media.id),
            media.objectKey,
            messageTtlSeconds,
          );
          media.chatType = toType;
          media.roomId = toId;
          await this.redis.set(
            mediaKey,
            JSON.stringify(media),
            "EX",
            messageTtlSeconds,
          );
        }
      }
    }

    await this.redis.del(fromKey);
    await this.removeLobby(fromType, fromId);

    if (Object.keys(messagesObject).length === 0) {
      return;
    }

    const merged = await this.redis.hgetall(toKey);
    const messages = Object.values(merged)
      .map((value) => JSON.parse(value))
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

    void this.to(toType, toId, "messages", { id: toId, messages });
  }
}
