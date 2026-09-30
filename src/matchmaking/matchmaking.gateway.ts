import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { e_match_types_enum } from "generated";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { CacheService } from "src/cache/cache.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { JoinQueueError } from "./utilities/joinQueueError";
import { PlayerLobby } from "./types/PlayerLobby";
import { HasuraService } from "src/hasura/hasura.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import { SocketsService } from "src/sockets/sockets.service";
import { TermsService } from "src/terms/terms.service";
import { WebsiteRestrictionsService } from "src/website-restrictions/website-restrictions.service";
import { resolveMatchmakingQueueVariant } from "./types/MatchmakingQueueVariant";
import {
  CaptainPickActionError,
  CaptainPickService,
} from "./captain-pick/captain-pick.service";
import { CaptainPickSettingsService } from "./captain-pick/captain-pick-settings.service";
import {
  CAPTAIN_PICK_COMMITTED_ERROR,
  getCaptainPickJoinError,
} from "./captain-pick/captain-pick-queue-rules";

@WebSocketGateway({
  path: "/ws/web",
})
export class MatchmakingGateway {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    public readonly matchmakeService: MatchmakeService,
    public readonly matchmakingLobbyService: MatchmakingLobbyService,
    private readonly cache: CacheService,
    private readonly terms: TermsService,
    private readonly websiteRestrictions: WebsiteRestrictionsService,
    private readonly captainPick: CaptainPickService,
    private readonly captainPickSettings: CaptainPickSettingsService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  @SubscribeMessage("matchmaking:join-queue")
  async joinQueue(
    @MessageBody()
    data: {
      type: e_match_types_enum;
      regions: Array<string>;
      variant?: unknown;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            _or: [
              {
                name: {
                  _eq: "public.matchmaking",
                },
              },
              {
                name: {
                  _eq: "public.matchmaking_min_role",
                },
              },
              {
                name: {
                  _eq: "public.max_acceptable_latency",
                },
              },
              {
                name: {
                  _eq: "public.matchmaking_competitive",
                },
              },
              {
                name: {
                  _eq: "public.matchmaking_wingman",
                },
              },
              {
                name: {
                  _eq: "public.matchmaking_duel",
                },
              },
            ],
          },
        },
        name: true,
        value: true,
      },
    });

    const variant = resolveMatchmakingQueueVariant(data.variant);

    const matchmakingAllowed = settings.find(
      (setting) =>
        setting.name === `public.matchmaking_${data.type.toLowerCase()}`,
    );

    // Captain Pick has its own switch (checked below), independent of the
    // Standard 5v5 toggle.
    if (variant !== "CaptainPick" && matchmakingAllowed?.value === "false") {
      throw new JoinQueueError("Matchmaking is not allowed");
    }

    const matchmakingEnabled = settings.find(
      (setting) => setting.name === "public.matchmaking",
    );

    if (matchmakingEnabled && matchmakingEnabled.value === "false") {
      throw new JoinQueueError("Matchmaking is disabled");
    }

    const matchmakingMinRole = settings.find(
      (setting) => setting.name === "public.matchmaking_min_role",
    );

    const maxAcceptableLatency = parseInt(
      settings.find(
        (setting) => setting.name === "public.max_acceptable_latency",
      )?.value || "100",
    );

    if (
      matchmakingMinRole &&
      !isRoleAbove(
        client.user.role,
        matchmakingMinRole.value as e_player_roles_enum,
      )
    ) {
      throw new JoinQueueError("You do not have permission to join this queue");
    }

    let lobby: PlayerLobby | undefined;
    const user = client.user;

    if (!user) {
      return;
    }

    const restriction = await this.websiteRestrictions.getStatus(user.steam_id);
    if (restriction.active) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: user.steam_id,
          event: "matchmaking:error",
          data: { message: "Your account is restricted to read-only access" },
        }),
      );
      return;
    }

    const { server_regions } = await this.hasura.query({
      server_regions: {
        __args: {
          where: {
            status: {
              _neq: "Disabled",
            },
          },
        },
        value: true,
        is_lan: true,
        status: true,
      },
    });

    const { game_server_nodes_aggregate } = await this.hasura.query({
      game_server_nodes_aggregate: {
        __args: {
          where: {
            enabled: {
              _eq: true,
            },
            status: {
              _eq: "Online",
            },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    try {
      if (!variant) {
        throw new JoinQueueError("Unknown matchmaking queue");
      }

      const latencyResults = await this.getLatencyResults(client);

      let checkLatency = false;
      if (game_server_nodes_aggregate.aggregate.count !== 0) {
        checkLatency = true;
        if (Object.keys(latencyResults).length === 0) {
          // TODO - they dont have latency checks, since we dont have a TURN server there is no relaible way to check latency
          checkLatency = false;
        }
      }

      // TODO - rather adding all regions at once we should add them when expanding the search
      let regions = [];
      let pingTooHigh = false;
      for (const region of data.regions) {
        const server_region = server_regions.find((server_region) => {
          return server_region.value === region;
        });

        if (!server_region) {
          continue;
        }

        const latency =
          latencyResults[region.toLocaleLowerCase().replace(" ", "_")];

        if (
          checkLatency == false ||
          !server_region.is_lan ||
          latency?.isLan === true
        ) {
          if (latency && latency.latency > maxAcceptableLatency) {
            pingTooHigh = true;
            continue;
          }
          regions.push(server_region.value);
        }
      }

      if (regions.length === 0) {
        throw new JoinQueueError(
          pingTooHigh ? "Ping too high to join queue" : "No regions available",
        );
      }

      const { type } = data;

      if (!type) {
        throw new JoinQueueError("Missing Type");
      }

      lobby = await this.matchmakingLobbyService.getPlayerLobby(user.steam_id);

      if (!lobby) {
        throw new JoinQueueError("Unable to find Player Lobby");
      }

      // A committed Captain Pick player belongs to that match until it is
      // over; no other queue (Captain Pick included) until then.
      for (const player of lobby.players) {
        if (await this.captainPick.getActiveDraftId(player.steam_id)) {
          throw new JoinQueueError(CAPTAIN_PICK_COMMITTED_ERROR, lobby.id);
        }
      }

      if (variant === "CaptainPick") {
        const { enabled } = await this.captainPickSettings.getSettings();
        const captainPickError = getCaptainPickJoinError({
          type,
          enabled,
          partySize: lobby.players.length,
        });

        if (captainPickError) {
          throw new JoinQueueError(captainPickError, lobby.id);
        }
      }

      // Every party member must have accepted the current Terms, not just
      // the caller -- otherwise an accepted leader could bring an
      // unaccepted party member into matchmaking with them. lobby.id is
      // passed so the catch block below broadcasts this to the whole
      // party, not just whoever triggered the join.
      for (const player of lobby.players) {
        if ((await this.websiteRestrictions.getStatus(player.steam_id)).active) {
          throw new JoinQueueError(
            "A party member's account is restricted to read-only access",
            lobby.id,
          );
        }
        if (!(await this.terms.hasAcceptedCurrentTerms(player.steam_id))) {
          throw new JoinQueueError(
            "All party members must accept the current Terms of Service and DEAFCS Rules before joining queue",
            lobby.id,
          );
        }
      }

      try {
        await this.cache.lock(`matchmaking:verify:${lobby.id}`, async () => {
          await this.matchmakingLobbyService.verifyLobby(lobby, user, type);
          await this.matchmakingLobbyService.setLobbyDetails(
            regions,
            type,
            lobby,
            variant,
          );
          await this.matchmakeService.addLobbyToQueue(lobby.id);
          return true;
        });
      } catch (error) {
        if (error instanceof JoinQueueError) {
          throw error;
        }
        this.logger.error(`unable to add lobby to queue`, error);
        await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
        await this.matchmakingLobbyService.removeLobbyDetails(lobby.id);
        throw new JoinQueueError("Unknown Error");
      }

      await this.matchmakeService.sendRegionStats();

      for (const region of regions) {
        void this.matchmakeService.matchmakeQueue(type, region, variant);
      }
    } catch (error) {
      if (error instanceof JoinQueueError) {
        let steamIds = [user.steam_id];

        if (lobby && error.getLobbyId()) {
          steamIds = lobby.players.map((player) => player.steam_id);
        }

        for (const steamId of steamIds) {
          await this.redis.publish(
            `send-message-to-steam-id`,
            JSON.stringify({
              steamId,
              event: "matchmaking:error",
              data: {
                message: error.message,
              },
            }),
          );
        }

        return;
      }
      this.logger.error(`unable to join queue`, error);
    }
  }

  @SubscribeMessage("matchmaking:leave")
  async leaveQueue(@ConnectedSocket() client: FiveStackWebSocketClient) {
    const user = client.user;

    if (!user) {
      return;
    }

    // After 10/10 Ready the group is committed: leaving would let one player
    // dodge a drafted team and throw the other nine back into the queue.
    if (await this.captainPick.getActiveDraftId(user.steam_id)) {
      await this.sendError(user.steam_id, CAPTAIN_PICK_COMMITTED_ERROR);
      return;
    }

    const lobby = await this.matchmakingLobbyService.getPlayerLobby(
      user.steam_id,
    );

    if (!lobby) {
      return;
    }

    await this.matchmakeService.releaseLobbyLock(lobby.id, 0);
    await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.id);
    await this.matchmakingLobbyService.removeLobbyDetails(lobby.id);

    // Same reasoning as MarkPlayerOffline -- removing the lobby fixes the
    // Redis truth, but every connected client's "N in queue" badge is
    // stale until someone is told it changed.
    await this.matchmakeService.sendRegionStats();
  }

  @SubscribeMessage("matchmaking:confirm")
  async playerConfirmation(
    @MessageBody()
    data: {
      confirmationId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    if (!user) {
      return;
    }
    const { confirmationId } = data;

    try {
      await this.websiteRestrictions.assertCanParticipate(user.steam_id);
    } catch {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: user.steam_id,
          event: "matchmaking:error",
          data: { message: "Your account is restricted to read-only access" },
        }),
      );
      return;
    }

    if (!(await this.terms.hasAcceptedCurrentTerms(user.steam_id))) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: user.steam_id,
          event: "matchmaking:error",
          data: {
            message:
              "You must accept the current Terms of Service and DEAFCS Rules before confirming a match",
          },
        }),
      );
      return;
    }

    await this.matchmakeService.playerConfirmMatchmaking(
      confirmationId,
      user.steam_id,
    );
  }

  /**
   * A captain picking a player. Only the target and the pick index the
   * client was looking at come from the client; who is picking is always the
   * authenticated socket user, and the draft service decides whether it is
   * their turn. The pick index is required so a double click can never turn
   * into the same captain's next (consecutive) pick.
   */
  @SubscribeMessage("matchmaking:captain-pick")
  async captainPickPlayer(
    @MessageBody()
    data: {
      confirmationId?: unknown;
      steamId?: unknown;
      pickIndex?: unknown;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    if (!user) {
      return;
    }

    const { confirmationId, steamId, pickIndex } = data ?? {};

    if (
      typeof confirmationId !== "string" ||
      (typeof steamId !== "string" && typeof steamId !== "number") ||
      !Number.isInteger(pickIndex)
    ) {
      await this.sendError(user.steam_id, "Invalid pick.");
      return;
    }

    // Only the draft this player actually belongs to can be acted on.
    if (
      (await this.captainPick.getActiveDraftId(user.steam_id)) !==
      confirmationId
    ) {
      await this.sendError(user.steam_id, "You are not in this draft.");
      return;
    }

    try {
      await this.captainPick.pick(
        confirmationId,
        String(user.steam_id),
        String(steamId),
        pickIndex as number,
      );
    } catch (error) {
      if (error instanceof CaptainPickActionError) {
        await this.sendError(user.steam_id, error.message);
        // Resync whatever screen sent a stale or invalid pick.
        await this.captainPick.publishState(confirmationId, [
          String(user.steam_id),
        ]);
        return;
      }
      this.logger.error(`unable to apply captain pick`, error);
      await this.sendError(user.steam_id, "Unable to make that pick.");
    }
  }

  /**
   * Whether a match is an active Captain Pick draft's match, and whether the
   * asking player is one of its ten. Lets the match page lock the drafted
   * lineups against manual edits and offer the ten players their Match chat
   * (which the chat service authorizes on its own). Answers only the asker.
   */
  @SubscribeMessage("matchmaking:captain-pick:match-status")
  async captainPickMatchStatus(
    @MessageBody() data: { matchId?: unknown },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    const user = client.user;
    const matchId = data?.matchId;
    if (!user || typeof matchId !== "string" || !matchId) {
      return;
    }

    const status = await this.captainPick.getMatchDraftStatus(
      matchId,
      String(user.steam_id),
    );

    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId: user.steam_id,
        event: "matchmaking:captain-pick:match-status",
        data: { matchId, ...status },
      }),
    );
  }

  private async sendError(steamId: string, message: string) {
    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({
        steamId,
        event: "matchmaking:error",
        data: { message },
      }),
    );
  }

  private async getLatencyResults(client: FiveStackWebSocketClient) {
    const data = await this.redis.hgetall(
      SocketsService.GET_PLAYER_CLIENT_LATENCY_TEST(client.sessionId),
    );

    const latencyResults: Record<
      string,
      {
        isLan: boolean;
        latency: number;
      }
    > = {};

    for (const key in data) {
      latencyResults[key] = JSON.parse(data[key]);
    }

    return latencyResults;
  }
}
