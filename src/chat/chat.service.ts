import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { e_player_roles_enum, e_notification_types_enum } from "generated/schema";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { NotificationsService } from "../notifications/notifications.service";
@Injectable()
export class ChatService {
  private redis: Redis;

  private expiresIn = 60 * 60 * 24;

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly notifications: NotificationsService,
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
        const { tournaments } = await this.hasuraService.query(
          {
            tournaments: {
              __args: {
                where: {
                  id: {
                    _eq: id,
                  },
                  _or: [
                    {
                      is_organizer: {
                        _eq: true,
                      },
                    },
                    {
                      teams: {
                        _or: [
                          {
                            owner_steam_id: {
                              _eq: user.steam_id,
                            },
                          },
                          {
                            roster: {
                              player_steam_id: {
                                _eq: user.steam_id,
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              id: true,
            },
          },
          user.steam_id,
        );

        if (tournaments.length === 0) {
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
      case ChatLobbyType.Direct: {
        const parties = id.split(":");
        if (
          parties.length !== 2 ||
          !parties.includes(String(user.steam_id))
        ) {
          return;
        }

        // Admins can DM anyone; everyone else can only DM an accepted
        // friend -- opening a DM used to only check that the requester
        // was one of the two parties in the id, which anyone can derive
        // from any two steam ids (it's just a sorted pair), so this was
        // the only thing actually stopping unsolicited DMs to strangers.
        if (!isRoleAbove(user.role, "administrator")) {
          const otherSteamId = parties.find(
            (p) => p !== String(user.steam_id),
          );
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

    const messagesObject = await this.redis.hgetall(`chat_${type}_${id}`);

    const messages = Object.entries(messagesObject).map(([, value]) =>
      JSON.parse(value),
    );

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

  public async sendMessageToChat(
    type: ChatLobbyType,
    id: string,
    player: User,
    _message: string,
    skipCheck = false,
  ) {
    // verify they are in the lobby
    if (skipCheck === false) {
      const userData = await this.getUserData(type, id, player.steam_id);
      if (!userData) {
        return;
      }

      if (
        type === ChatLobbyType.Draft &&
        !(await this.canSendDraftMessage(id, player))
      ) {
        return;
      }
    }

    const name = await this.redis.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(player.steam_id),
    );

    const role: e_player_roles_enum = (await this.redis.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(player.steam_id),
    )) as unknown as e_player_roles_enum;

    const timestamp = new Date();
    const message = {
      message: _message,
      timestamp: timestamp.toISOString(),
      from: {
        role: name ? JSON.parse(role) : player.role,
        name: name ? JSON.parse(name) : player.name,
        steam_id: player.steam_id,
        avatar_url: player.avatar_url,
        profile_url: player.profile_url,
      },
    };

    const messageKey = `chat_${type}_${id}`;
    const messageField = `${player.steam_id}:${Date.now().toString()}`;
    await this.redis.hset(messageKey, messageField, JSON.stringify(message));

    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        messageKey,
        this.expiresIn,
        "FIELDS",
        1,
        messageField,
      ]),
    );

    void this.to(type, id, "chat", message);

    // Best-effort push for anyone who's a member of this lobby but isn't
    // currently connected to it (getAllUsersInLobby only ever holds
    // people with an open socket to this exact channel -- i.e. already
    // seeing the message live, so they're excluded rather than targeted).
    // A failure here must never break message delivery, hence the catch.
    void this.notifyLobbyMembers(type, id, player, _message).catch(
      (error) =>
        this.logger.warn(
          `[chat] push notify failed for ${type}:${id}: ${(error as Error)?.message}`,
        ),
    );
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
          title: sender.name || "New message",
          message:
            message.length > 200 ? `${message.slice(0, 200)}…` : message,
          role: "verified_user" as e_player_roles_enum,
          entity_id: `${type}:${id}`,
        },
      );
      return;
    }

    const members = await this.getLobbyMemberSteamIds(type, id);
    if (!members.length) return;

    const senderId = String(sender.steam_id);
    const targets = members.filter((steamId) => steamId !== senderId);

    if (!targets.length) return;

    await this.notifications.notifyPlayers(
      "ChatMessage" as unknown as e_notification_types_enum,
      {
        title: sender.name || "New message",
        message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
        role: "user" as e_player_roles_enum,
        entity_id: `${type}:${id}`,
        steamIds: targets,
      },
    );
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
        const { tournament_team_roster, tournaments_by_pk } =
          await this.hasuraService.query({
            tournament_team_roster: {
              __args: { where: { tournament_id: { _eq: id } } },
              player_steam_id: true,
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
    event: "chat" | "list" | "messages" | "joined" | "left",
    data: Record<string, any>,
  ) {
    const users = await this.getAllUsersInLobby(type, id);
    const eventName = `lobby:${type}:${id}:${event}`;

    for (const { steamId } of users) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: eventName,
          data,
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
