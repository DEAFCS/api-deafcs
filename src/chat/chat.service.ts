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

@Injectable()
export class ChatService {
  private redis: Redis;

  private expiresIn = 60 * 60 * 24;

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

  public async joinMatchLobby(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    id: string,
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
            },
          },
          user.steam_id,
        );

        if (
          !match_lineups_by_pk ||
          match_lineups_by_pk.match_id !== matchId ||
          (!match_lineups_by_pk.is_on_lineup &&
            String(match_lineups_by_pk.coach_steam_id) !==
              String(user.steam_id))
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

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:messages`,
        data: {
          id,
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

  private async canAccessTournamentChat(
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
  ): Promise<{
    accepted: boolean;
    muteStatus?: WebsiteChatMuteStatus;
    restrictionStatus?: WebsiteRestrictionStatus;
  }> {
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

    const messageTtlSeconds = this.expiresIn;
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
    };

    let sentVideoMediaId: string | undefined;
    if (videoDraftId) {
      const media = await this.consumeVideoDraft(
        videoDraftId,
        type,
        id,
        player,
        messageTtlSeconds,
      );
      if (!media) return { accepted: false };
      message.media = media;
      sentVideoMediaId = String(media.id);
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
      const messageField = uuidv4();
      message.id = messageField;
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
      if (sentVideoMediaId) {
        await this.redis.expire(
          this.videoMediaKey(sentVideoMediaId),
          messageTtlSeconds,
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
    const id = await this.redis.get(this.videoTokenKey(token));
    if (!id) return undefined;
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) return undefined;
    const session = JSON.parse(raw);
    return session.state === "recording"
      ? {
          id,
          expiresAt: new Date(
            session.createdAt + this.videoDraftTtlSeconds * 1000,
          ).toISOString(),
        }
      : undefined;
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
    const lockKey = `chat_video_upload_lock:${id}`;
    if (!(await this.redis.set(lockKey, "1", "EX", 120, "NX")))
      return undefined;
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
      if (session.tokenKey) await this.redis.del(session.tokenKey);
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
    if (id) await this.cancelVideoDraft(id);
    await this.redis.del(tokenKey);
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
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (raw) {
      const session = JSON.parse(raw);
      if (session.state === "sent") {
        const values = await this.redis.hgetall(
          `chat_${session.type}_${session.roomId}`,
        );
        const attached = Object.values(values).some((value) => {
          try {
            return JSON.parse(value)?.media?.id === session.mediaId;
          } catch {
            return false;
          }
        });
        if (!attached && session.mediaId)
          await this.removeVideoMedia(session.mediaId);
        return;
      }
      if (session.tokenKey) await this.redis.del(session.tokenKey);
      await this.redis.del(`chat_video_claim:${id}`);
      await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
      if (session.mediaId) await this.removeVideoMedia(session.mediaId);
    }
    await this.redis.del(this.videoDraftKey(id));
    await this.redis.del(`chat_video_session_media:${id}`);
  }

  public async cleanupExpiredVideoDraft(id: string) {
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (raw) {
      const session = JSON.parse(raw);
      if (session.state === "sent") return;
      if (session.mediaId) await this.removeVideoMedia(session.mediaId);
      if (session.tokenKey) await this.redis.del(session.tokenKey);
      await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
      await this.redis.del(this.videoDraftKey(id));
    } else {
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

  private async consumeVideoDraft(
    id: string,
    type: ChatLobbyType,
    roomId: string,
    user: User,
    messageTtlSeconds = this.expiresIn,
  ) {
    const claimKey = `chat_video_claim:${id}`;
    if (
      !(await this.redis.set(
        claimKey,
        String(user.steam_id),
        "EX",
        this.videoMediaTtlSeconds,
        "NX",
      ))
    )
      return undefined;
    const raw = await this.redis.get(this.videoDraftKey(id));
    if (!raw) {
      await this.redis.del(claimKey);
      return undefined;
    }
    const session = JSON.parse(raw);
    if (
      session.state !== "ready" ||
      session.ownerSteamId !== String(user.steam_id) ||
      session.type !== type ||
      session.roomId !== roomId
    ) {
      await this.redis.del(claimKey);
      return undefined;
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
    try {
      await this.chatVideoCleanupQueue.add(
        ExpireSentChatVideoMediaJobName,
        { mediaId: media.id, objectKey: media.objectKey },
        {
          jobId: `chat-video-media-expiry-${media.id}`,
          delay: messageTtlSeconds * 1000 + 60 * 60 * 1000 + 1000,
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );
    } catch (error) {
      this.logger.warn(
        `[chat-video] unable to schedule message-lifetime cleanup for ${media.id}`,
        error,
      );
      await this.redis.del(claimKey);
      return undefined;
    }
    session.state = "sent";
    await this.redis.del(`chat_video_active:${session.ownerSteamId}`);
    await this.redis.set(
      this.videoDraftKey(id),
      JSON.stringify(session),
      "EX",
      this.videoMediaTtlSeconds,
    );
    return publicMedia;
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

  // Admin-only (re-checked here, not just trusted from the caller) --
  // edits an announcement in place and pushes the new text to everyone
  // currently viewing the channel. Announcements are the only chat type
  // with persistence, so this has no equivalent for any other lobby type.
  public async editAnnouncement(admin: User, id: string, _message: string) {
    if (!isRoleAbove(admin.role, "administrator")) {
      return;
    }

    if ((await this.websiteRestrictions.getStatus(admin.steam_id)).active) {
      return;
    }

    const message = _message.trim();
    if (!message) {
      return;
    }

    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.announcements
          SET message = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [id, message],
    );

    if (!rows[0]) {
      return;
    }

    void this.to(ChatLobbyType.Announcement, ANNOUNCEMENTS_LOBBY_ID, "edited", {
      id,
      message,
    });
  }

  public async deleteMessage(
    actor: User,
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
  ): Promise<boolean> {
    const currentActor = await this.getCurrentUser(actor.steam_id);
    if (!currentActor || !isRoleAbove(currentActor.role, "administrator")) {
      return false;
    }

    if ((await this.websiteRestrictions.getStatus(actor.steam_id)).active) {
      return false;
    }

    if (!Object.values(ChatLobbyType).includes(type)) {
      return false;
    }

    let audited = false;
    if (type === ChatLobbyType.Announcement) {
      if (roomId !== ANNOUNCEMENTS_LOBBY_ID) {
        return false;
      }
      const rows = await this.postgres.query<Array<{ message_id: string }>>(
        `WITH target AS (
           UPDATE public.announcements
              SET deleted_at = now(), deleted_by_steam_id = $2::bigint
            WHERE id = $1::uuid AND deleted_at IS NULL
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
        [messageId, currentActor.steam_id, roomId],
      );
      audited = rows.length > 0;
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

    // Match chat is its own notification type/push category, separate
    // from every other lobby chat (matchmaking queue, draft,
    // tournament, …) -- it fires far more often once a match is
    // actually live (including in-game console chat relayed in via
    // ChatMessageEvent), which players reported as distracting on
    // their phone mid-match. Defaults to OFF (see
    // notification-categories.ts) unlike the rest. (Organizer chat is
    // handled in its own early-return branch above, not here.)
    const notificationType =
      type === ChatLobbyType.Match ? "MatchChatMessage" : "ChatMessage";
    await this.notifications.notifyPlayers(
      notificationType as unknown as e_notification_types_enum,
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
      // Announcement-only: an admin edited/removed a persisted message
      // (see editAnnouncement/deleteAnnouncement) -- every other chat
      // type has no equivalent since nothing else persists messages.
      | "edited"
      | "deleted",
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

    const messagesObject = await this.redis.hgetall(fromKey);

    for (const [field, message] of Object.entries(messagesObject)) {
      await this.redis.hset(toKey, field, message);
      await this.redis.sendCommand(
        new Redis.Command("HEXPIRE", [
          toKey,
          this.expiresIn,
          "FIELDS",
          1,
          field,
        ]),
      );
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
