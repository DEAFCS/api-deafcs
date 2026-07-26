import Redis from "ioredis";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { e_map_pool_types_enum, e_match_types_enum } from "generated";
import { InjectQueue } from "@nestjs/bullmq";
import { MatchmakingTeam } from "./types/MatchmakingTeam";
import { HasuraService } from "src/hasura/hasura.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

@Injectable()
export class MatchmakeService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    public readonly matchAssistant: MatchAssistantService,
    private matchmakingLobbyService: MatchmakingLobbyService,
    @InjectQueue(MatchmakingQueues.Matchmaking) private queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async addLobbyToQueue(lobbyId: string) {
    const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);
    if (!lobby) {
      this.logger.warn(`Cannot requeue lobby ${lobbyId} - details not found`);
      return;
    }

    // store the lobby's rank in a separate sorted set for quick rank matching
    for (const region of lobby.regions) {
      await this.redis.zadd(
        getMatchmakingRankCacheKey(lobby.type, region),
        lobby.avgRank,
        lobbyId,
      );

      await this.redis.zadd(
        getMatchmakingQueueCacheKey(lobby.type, region),
        0, // score doesn't matter for queue cache
        lobbyId,
      );
    }

    await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
  }

  public async sendRegionStats(user?: User) {
    const regions = await this.hasura.query({
      server_regions: {
        __args: {
          where: {
            _and: [
              {
                total_server_count: {
                  _gt: 0,
                },
                is_lan: {
                  _eq: false,
                },
              },
            ],
          },
        },
        value: true,
      },
    });

    const types: e_match_types_enum[] = ["Duel", "Wingman", "Competitive"];

    const regionStats: Partial<
      Record<string, Partial<Record<e_match_types_enum, number[]>>>
    > = {};

    for (const type of types) {
      const lobbyIndexes = new Map<string, number>();

      for (const region of regions.server_regions) {
        const lobbyIds = await this.redis.zrange(
          getMatchmakingQueueCacheKey(type, region.value),
          0,
          -1,
        );

        const stats = (regionStats[region.value] ??= {});
        stats[type] = lobbyIds.map((lobbyId) => {
          let index = lobbyIndexes.get(lobbyId);
          if (index === undefined) {
            index = lobbyIndexes.size;
            lobbyIndexes.set(lobbyId, index);
          }
          return index;
        });
      }
    }

    if (user) {
      await this.redis.publish(
        `send-message-to-steam-id`,
        JSON.stringify({
          steamId: user.steam_id,
          event: "matchmaking:region-stats",
          data: regionStats,
        }),
      );

      return;
    }

    await this.redis.publish(
      `broadcast-message`,
      JSON.stringify({
        event: "matchmaking:region-stats",
        data: regionStats,
      }),
    );
  }

  public async matchmake(
    type: e_match_types_enum,
    region: string,
  ): Promise<void> {
    const lock = await this.aquireMatchmakeRegionLock(region);
    if (!lock) {
      this.logger.warn(
        `Unable to acquire region lock for ${region} - another matchmaking process is running`,
      );
      return;
    }

    // TODO - its possible, but highly unlikley we will ever runinto the issue of too many lobbies in the queue
    const lobbiesData = await this.redis.zrange(
      getMatchmakingRankCacheKey(type, region),
      0,
      -1,
      "WITHSCORES",
    );

    let lobbies = await this.processLobbyData(lobbiesData);

    if (lobbies.length === 0) {
      await this.releaseMatchmakeRegionLock(region);
      return;
    }

    // sort lobbies by average rank so lobbies with similar skill end up
    // adjacent to each other — the grouping step below relies on that
    // adjacency, and already expands its own rank tolerance the longer a
    // group has waited, so wait time doesn't need factoring in twice here.
    // (The previous version tried to blend rank and wait time in one
    // comparator, but the wait term wasn't antisymmetric between a/b, which
    // made the sort order effectively arbitrary.)
    lobbies = lobbies.sort((a, b) => a.avgRank - b.avgRank);

    // group lobbies based on rank differences that expand with wait time
    const groupedLobbies = [];
    let currentGroup = [lobbies.at(0)];

    for (const currentLobby of lobbies.slice(1)) {
      const firstLobbyInGroup = currentGroup.at(0);

      // calculate wait time in seconds
      const waitTimeSeconds = Math.max(
        10,
        Math.floor((Date.now() - firstLobbyInGroup.joinedAt.getTime()) / 1000),
      );

      // maximum allowed rank difference increases proportionally with wait time (100 per minute)
      const maxRankDiff = 25 * waitTimeSeconds;

      // check if current lobby's rank is within acceptable range
      if (
        Math.abs(currentLobby.avgRank - firstLobbyInGroup.avgRank) <=
        maxRankDiff
      ) {
        currentGroup.push(currentLobby);
        continue;
      }

      // start new group if rank difference is too high
      if (currentGroup.length > 0) {
        groupedLobbies.push([...currentGroup]);
      }
      currentGroup = [currentLobby];
    }

    // add final group
    if (currentGroup.length > 0) {
      groupedLobbies.push(currentGroup);
    }

    const createMatchesPromises = [];

    for (const group of groupedLobbies) {
      createMatchesPromises.push(this.createMatches(region, type, group));
    }

    // once all results are returned as false we no longer need to matchmake
    const results = await Promise.all(createMatchesPromises).finally(() => {
      void this.releaseMatchmakeRegionLock(region);
    });

    const totalPlayerNotQueued = results.reduce(
      (acc, result) => acc + result,
      0,
    );

    if (totalPlayerNotQueued < ExpectedPlayers[type]) {
      await this.releaseMatchmakeRegionLock(region);
      return;
    }

    this.logger.log(
      `${totalPlayerNotQueued} players not queued, expanding search....`,
    );

    // randomize the time to prevent all regions from matchingmake at the same time
    setTimeout(
      () => {
        void this.matchmake(type, region);
      },
      10000 + Math.floor(Math.random() * 10000),
    );
  }

  private async processLobbyData(
    lobbiesData: string[],
  ): Promise<MatchmakingLobby[]> {
    const lobbyDetails = [];

    for (let i = 0; i < lobbiesData.length; i += 2) {
      const details = await this.matchmakingLobbyService.getLobbyDetails(
        lobbiesData[i],
      );

      if (!details) {
        continue;
      }

      if (details.players.length === ExpectedPlayers[details.type]) {
        const lock = await this.claimLobby(details.lobbyId, details);
        if (!lock) {
          this.logger.warn(
            `Unable to acquire lobby lock for ${details.lobbyId} - lobby is already being processed`,
          );
          continue;
        }

        try {
          const shuffledPlayers = [...details.players].sort(
            () => Math.random() - 0.5,
          );
          const halfLength = Math.floor(shuffledPlayers.length / 2);

          const team1: MatchmakingTeam = {
            players: shuffledPlayers.slice(0, halfLength),
            lobbies: [],
            avgRank: 0,
          };
          const team2: MatchmakingTeam = {
            players: shuffledPlayers.slice(halfLength),
            lobbies: [],
            avgRank: 0,
          };

          team1.lobbies.push(details.lobbyId);
          team2.lobbies.push(details.lobbyId);

          team1.avgRank =
            team1.players.reduce((acc, player) => acc + player.rank, 0) /
            team1.players.length;
          team2.avgRank =
            team2.players.reduce((acc, player) => acc + player.rank, 0) /
            team2.players.length;

          const region = details.regions.at(0);

          await this.createMatchConfirmation(region, details.type, {
            team1,
            team2,
          });
        } catch (error) {
          this.logger.error(
            `Error creating match confirmation for lobby ${details.lobbyId}:`,
            error,
          );
          await this.releaseLobbyAndRequeue(details.lobbyId);
        }

        continue;
      }
      lobbyDetails.push({
        ...details,
        avgRank: parseInt(lobbiesData[i + 1]),
        joinedAt: new Date(details.joinedAt),
      });
    }

    return lobbyDetails;
  }

  private async createMatches(
    region: string,
    type: e_match_types_enum,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<number> {
    const requiredPlayers = ExpectedPlayers[type];
    const totalPlayers = lobbies.reduce(
      (acc, lobby) => acc + lobby.players.length,
      0,
    );

    if (lobbies.length === 0) {
      return 0;
    }

    if (totalPlayers < requiredPlayers) {
      return totalPlayers;
    }

    const playersPerTeam = requiredPlayers / 2;

    // select which lobbies fill this match (up to exactly requiredPlayers
    // total) — team assignment happens afterward, once we know the full
    // participant list, so it can find the best possible split instead of
    // deciding team-by-team as lobbies happen to arrive.
    const selectedLobbies: Array<MatchmakingLobby> = [];
    let selectedPlayerCount = 0;
    const lobbiesAdded: Array<string> = [];
    let lobbyLocks = new Set<string>();

    for (const lobby of lobbies) {
      if (selectedPlayerCount >= requiredPlayers) {
        break;
      }

      try {
        const lock = await this.claimLobby(lobby.lobbyId, lobby);

        if (!lock) {
          this.logger.warn(
            `Unable to acquire lobby lock for ${lobby.lobbyId} - lobby is already being processed`,
          );
          continue;
        }

        if (selectedPlayerCount + lobby.players.length > requiredPlayers) {
          // doesn't fit in what's left of this match
          await this.releaseLobbyAndRequeue(lobby.lobbyId);
          continue;
        }

        lobbyLocks.add(lobby.lobbyId);
        selectedLobbies.push(lobby);
        selectedPlayerCount += lobby.players.length;
        lobbiesAdded.push(lobby.lobbyId);
      } catch (error) {
        this.logger.error(`Error processing lobby ${lobby.lobbyId}:`, error);
        // If we acquired a lock but failed to process, release it
        if (lobbyLocks.has(lobby.lobbyId)) {
          await this.releaseLobbyAndRequeue(lobby.lobbyId);
          lobbyLocks.delete(lobby.lobbyId);
        }
      }
    }

    for (const lobbyId of lobbiesAdded) {
      const lobbyIndex = lobbies.findIndex(
        (lobby) => lobby.lobbyId === lobbyId,
      );
      if (lobbyIndex !== -1) {
        lobbies.splice(lobbyIndex, 1);
      }
    }

    let totalPlayerNotQueued = 0;
    let team1: MatchmakingTeam = { players: [], lobbies: [], avgRank: 0 };
    let team2: MatchmakingTeam = { players: [], lobbies: [], avgRank: 0 };

    // check if we have a full match's worth of players
    if (selectedPlayerCount === requiredPlayers) {
      const { teamA, teamB } = this.splitIntoBalancedTeams(
        selectedLobbies,
        playersPerTeam,
      );
      team1 = this.buildTeamFromLobbies(teamA);
      team2 = this.buildTeamFromLobbies(teamB);

      try {
        // lobby locks will be released after confimrmation
        for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
          lobbyLocks.delete(lobbyId);
        }

        await this.createMatchConfirmation(region, type, {
          team1,
          team2,
        });
      } catch (error) {
        this.logger.error(`Error creating match confirmation:`, error);
        // Release all locks if match confirmation fails
        for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
          await this.releaseLobbyAndRequeue(lobbyId);
        }
        totalPlayerNotQueued = team1.players.length + team2.players.length;
      }
    } else {
      totalPlayerNotQueued = selectedPlayerCount;
      // Release all acquired locks since we can't create a match
      for (const lobby of selectedLobbies) {
        await this.releaseLobbyAndRequeue(lobby.lobbyId);
      }
    }

    // only try to re-matchmake lobbies that we were able to accuire a lock for
    const lobbiesToMatch = lobbies.filter((lobby) =>
      lobbyLocks.has(lobby.lobbyId),
    );
    if (lobbiesToMatch.length > 0) {
      for (const lobby of lobbiesToMatch) {
        await this.releaseLobbyAndRequeue(lobby.lobbyId);
      }
      await this.createMatches(region, type, lobbiesToMatch);
    }

    // Safety check: ensure all remaining locks are released
    if (lobbyLocks.size > 0) {
      for (const lobbyId of lobbyLocks) {
        await this.releaseLobbyAndRequeue(lobbyId);
      }
    }

    return totalPlayerNotQueued;
  }

  private buildTeamFromLobbies(
    lobbies: Array<MatchmakingLobby>,
  ): MatchmakingTeam {
    const players = lobbies.flatMap((lobby) => lobby.players);
    return {
      players,
      lobbies: lobbies.map((lobby) => lobby.lobbyId),
      avgRank: players.length
        ? players.reduce((acc, player) => acc + player.rank, 0) /
          players.length
        : 0,
    };
  }

  // Finds the exact split of `lobbies` into two teams (of `teamSize` players
  // each) that minimizes the difference in total rank — a lobby/party always
  // stays together on one side. The candidate pool is always small (at most
  // one match's worth of players, e.g. 10 for Competitive), so a full
  // combinatorial search is cheap and, unlike a greedy pick, always finds the
  // best possible pairing (e.g. pairing the highest and lowest rank together
  // when that beats pairing them with the middle).
  private splitIntoBalancedTeams(
    lobbies: Array<MatchmakingLobby>,
    teamSize: number,
  ): { teamA: Array<MatchmakingLobby>; teamB: Array<MatchmakingLobby> } {
    const lobbyRank = (lobby: MatchmakingLobby) =>
      lobby.players.reduce((acc, player) => acc + player.rank, 0);

    const totalRank = lobbies.reduce(
      (acc, lobby) => acc + lobbyRank(lobby),
      0,
    );

    let bestIndices: number[] | null = null;
    let bestDiff = Infinity;
    const chosen: number[] = [];

    const search = (start: number, size: number, rankSum: number) => {
      if (size === teamSize) {
        const diff = Math.abs(2 * rankSum - totalRank);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIndices = [...chosen];
        }
        return;
      }

      for (let i = start; i < lobbies.length; i++) {
        const lobby = lobbies[i];
        if (size + lobby.players.length > teamSize) {
          continue;
        }
        chosen.push(i);
        search(i + 1, size + lobby.players.length, rankSum + lobbyRank(lobby));
        chosen.pop();
      }
    };

    search(0, 0, 0);

    // Every lobby is guaranteed to fit exactly into two teamSize halves by
    // the caller (selectedPlayerCount === requiredPlayers), so a split always
    // exists — this is just a defensive fallback.
    const indices = bestIndices ?? lobbies.map((_, i) => i).slice(0, 0);
    const indexSet = new Set<number>(indices);

    return {
      teamA: lobbies.filter((_, i) => indexSet.has(i)),
      teamB: lobbies.filter((_, i) => !indexSet.has(i)),
    };
  }

  private async aquireMatchmakeRegionLock(region: string): Promise<boolean> {
    const lockKey = `matchmaking:lock:${region}`;

    const result = await this.redis.set(lockKey, 1, "EX", 60, "NX");

    if (result === null) {
      return false;
    }

    return true;
  }

  private async releaseMatchmakeRegionLock(region: string) {
    const lockKey = `matchmaking:lock:${region}`;
    await this.redis.del(lockKey);
  }

  private static readonly CLAIM_LOBBY_SCRIPT = `
    local acquired = redis.call('SET', KEYS[1], 1, 'EX', ARGV[2], 'NX')
    if not acquired then
      return 0
    end
    for i = 2, #KEYS do
      redis.call('ZREM', KEYS[i], ARGV[1])
    end
    return 1
  `;

  private async claimLobby(
    lobbyId: string,
    existingLobby?: MatchmakingLobby,
  ): Promise<boolean> {
    const lobby =
      existingLobby ??
      (await this.matchmakingLobbyService.getLobbyDetails(lobbyId));
    if (!lobby) {
      return false;
    }

    const lockKey = `matchmaking:lock:${lobbyId}`;
    const keys: string[] = [lockKey];

    for (const region of lobby.regions) {
      keys.push(getMatchmakingQueueCacheKey(lobby.type, region));
      keys.push(getMatchmakingRankCacheKey(lobby.type, region));
    }

    const result = await this.redis.eval(
      MatchmakeService.CLAIM_LOBBY_SCRIPT,
      keys.length,
      ...keys,
      lobbyId,
      10, // TTL in seconds
    );

    return result === 1;
  }

  private async releaseLobbyAndRequeue(lobbyId: string): Promise<void> {
    await this.releaseLobbyLock(lobbyId, 0);
    await this.addLobbyToQueue(lobbyId);
  }

  public async releaseLobbyLock(lobbyId: string, seconds: number) {
    const lockKey = `matchmaking:lock:${lobbyId}`;
    await this.redis.expire(lockKey, seconds);
  }

  public async markOffline(steamId: string) {
    await this.queue.add(
      "MarkPlayerOffline",
      {
        steamId,
      },
      {
        delay: 60 * 1000,
        jobId: `matchmaking.mark-offline.${steamId}`,
      },
    );
  }

  public async cancelOffline(steamId: string) {
    await this.queue.remove(`matchmaking.mark-offline.${steamId}`);
  }

  private async createMatchConfirmation(
    region: string,
    type: e_match_types_enum,
    players: { team1: MatchmakingTeam; team2: MatchmakingTeam },
  ) {
    if (!region) {
      throw new Error("Region is required");
    }
    const { team1, team2 } = players;

    const allLobbies = new Set([...team1.lobbies, ...team2.lobbies]);

    for (const lobbyId of allLobbies) {
      void this.releaseLobbyLock(lobbyId, 30);
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 30);

    const confirmationId = uuidv4();

    await this.setConfirmationDetails(
      region,
      type,
      confirmationId,
      team1,
      team2,
    );

    for (const lobbyId of [...team1.lobbies, ...team2.lobbies]) {
      await this.matchmakingLobbyService.setMatchConformationIdForLobby(
        lobbyId,
        confirmationId,
      );
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }

    await this.cancelMatchMakingDueToReadyCheck(confirmationId);
  }

  public async cancelMatchMakingDueToReadyCheck(confirmationId: string) {
    await this.queue.add(
      "CancelMatchMaking",
      {
        confirmationId,
      },
      {
        delay: 30 * 1000,
        jobId: this.getMatchMakingCancelJobId(confirmationId),
      },
    );
  }

  private async removeCancelMatchMakingJob(confirmationId: string) {
    await this.queue.remove(this.getMatchMakingCancelJobId(confirmationId));
  }

  private getMatchMakingCancelJobId(confirmationId: string) {
    return `matchmaking.cancel.${confirmationId}`;
  }

  private async setConfirmationDetails(
    region: string,
    type: e_match_types_enum,
    confirmationId: string,
    team1: MatchmakingTeam,
    team2: MatchmakingTeam,
  ) {
    await this.redis.hset(getMatchmakingConformationCacheKey(confirmationId), {
      type,
      region,
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      lobbyIds: JSON.stringify([...team1.lobbies, ...team2.lobbies]),
      team1: JSON.stringify(team1.players),
      team2: JSON.stringify(team2.players),
    });
  }

  public async removeConfirmationDetails(confirmationId: string) {
    const confirmedKey = `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`;
    await this.redis.del(confirmedKey);

    await this.redis.del(getMatchmakingConformationCacheKey(confirmationId));
  }

  public async getMatchConfirmationDetails(confirmationId: string): Promise<{
    type: e_match_types_enum;
    region: string;
    lobbyIds: string[];
    team1: { steam_id: string; rank: number }[];
    team2: { steam_id: string; rank: number }[];
    matchId: string;
    expiresAt: string;
    confirmed: string[];
  }> {
    const { type, region, lobbyIds, team1, team2, matchId, expiresAt } =
      await this.redis.hgetall(
        getMatchmakingConformationCacheKey(confirmationId),
      );

    const confirmed = await this.redis.hgetall(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
    );

    return {
      region,
      matchId,
      expiresAt,
      type: type as e_match_types_enum,
      team1: JSON.parse(team1 || "[]"),
      team2: JSON.parse(team2 || "[]"),
      lobbyIds: JSON.parse(lobbyIds || "[]"),
      confirmed: Object.keys(confirmed),
    };
  }

  public async cancelMatchMakingByMatchId(matchId: string) {
    const confirmationId = await this.redis.get(
      `matches:confirmation:${matchId}`,
    );

    if (confirmationId) {
      await this.cancelMatchMaking(confirmationId, true);
    }

    await this.redis.del(`matches:confirmation:${matchId}`);
  }

  public async cancelMatchMaking(confirmationId: string, hasMatch = false) {
    let shouldMatchmake = false;
    const { lobbyIds, type, region } =
      await this.getMatchConfirmationDetails(confirmationId);

    for (const lobbyId of lobbyIds) {
      const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

      if (!lobby) {
        continue;
      }

      let requeue = !hasMatch;
      if (!hasMatch) {
        for (const player of lobby.players) {
          const wasReady = await this.redis.hget(
            `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
            player.steam_id,
          );

          if (!wasReady) {
            requeue = false;
            break;
          }
        }
      }

      await this.matchmakingLobbyService.removeLobbyFromQueue(lobbyId);
      await this.matchmakingLobbyService.removeConfirmationIdFromLobby(lobbyId);

      if (!requeue) {
        await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);
        continue;
      }

      shouldMatchmake = true;
      await this.addLobbyToQueue(lobbyId);
    }

    await this.removeConfirmationDetails(confirmationId);

    await this.sendRegionStats();

    if (shouldMatchmake) {
      // randomize the time to prevent all regions from matchingmake at the same time
      setTimeout(
        () => {
          void this.matchmake(type, region);
        },
        Math.floor(Math.random() * 10000),
      );
    }
  }

  public async playerConfirmMatchmaking(
    confirmationId: string,
    steamId: string,
  ) {
    await this.redis.hset(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
      steamId,
      1,
    );

    const { lobbyIds, team1, team2, confirmed } =
      await this.getMatchConfirmationDetails(confirmationId);

    if (confirmed.length != team1.length + team2.length) {
      for (const lobbyId of lobbyIds) {
        void this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      }
      return;
    }

    await this.createMatch(confirmationId);
  }

  private async createMatch(confirmationId: string) {
    const { team1, team2, type, region, lobbyIds } =
      await this.getMatchConfirmationDetails(confirmationId);

    await this.removeCancelMatchMakingJob(confirmationId);

    // e_map_pool_types_enum doesn't include Premier/Faceit (imports only).
    const mapPoolType: e_map_pool_types_enum =
      type === "Premier" || type === "Faceit" ? "Competitive" : type;
    const match = await this.matchAssistant.createMatchBasedOnType(
      type,
      mapPoolType,
      {
        mr: type === "Competitive" ? 12 : 8,
        best_of: 1,
        knife: true,
        overtime: true,
        timeout_setting: "Admin",
        region,
      },
    );

    // The match_lineup_players trigger (tbid_match_lineup_players) makes
    // whichever row is inserted first for a lineup its captain, so sorting
    // by rank descending before the insert makes the highest-ELO player on
    // each team the captain, instead of whoever happened to be first in the
    // (essentially arbitrary) queue-join order.
    const byRankDesc = (a: { rank: number }, b: { rank: number }) =>
      b.rank - a.rank;

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: [...team1]
            .sort(byRankDesc)
            .map((player) => ({
              steam_id: player.steam_id,
              match_lineup_id: match.lineup_1_id,
            })),
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: [...team2]
            .sort(byRankDesc)
            .map((player) => ({
              steam_id: player.steam_id,
              match_lineup_id: match.lineup_2_id,
            })),
        },
        __typename: true,
      },
    });

    await this.matchAssistant.updateMatchStatus(match.id, "Live");

    // add match id to the confirmation details
    await this.redis.hset(
      getMatchmakingConformationCacheKey(confirmationId),
      "matchId",
      match.id,
    );

    await this.redis.set(`matches:confirmation:${match.id}`, confirmationId);

    for (const lobbyId of lobbyIds) {
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }
  }
}
