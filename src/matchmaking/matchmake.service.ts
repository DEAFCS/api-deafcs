import Redis from "ioredis";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { e_match_types_enum } from "generated";
import { InjectQueue } from "@nestjs/bullmq";
import { MatchmakingTeam } from "./types/MatchmakingTeam";
import { HasuraService } from "src/hasura/hasura.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { PushNotificationsService } from "src/notifications/push/push-notifications.service";
import {
  getMatchmakingQueueCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
  getMatchmakingRegionLockKey,
  getMatchmakingPlayerClaimKey,
} from "./utilities/cacheKeys";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
import {
  getMatchmakingRegionStatsKey,
  MatchmakingQueueVariant,
  resolveMatchmakingQueueVariant,
} from "./types/MatchmakingQueueVariant";
import { getMatchmakingMatchSetup } from "./utilities/matchmakingMatchSetup";
import { CaptainPickService } from "./captain-pick/captain-pick.service";
import { CaptainPickSettingsService } from "./captain-pick/captain-pick-settings.service";
import {
  CAPTAIN_PICK_DISABLED_ERROR,
  CAPTAIN_PICK_SOLO_ONLY_ERROR,
} from "./captain-pick/captain-pick-queue-rules";
import { CAPTAIN_PICK_PLAYER_COUNT } from "./captain-pick/captain-pick-rules";

@Injectable()
export class MatchmakeService {
  public redis: Redis;

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly redisManager: RedisManagerService,
    public readonly matchAssistant: MatchAssistantService,
    private matchmakingLobbyService: MatchmakingLobbyService,
    private readonly pushNotifications: PushNotificationsService,
    private readonly captainPick: CaptainPickService,
    private readonly captainPickSettings: CaptainPickSettingsService,
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
        getMatchmakingRankCacheKey(lobby.type, region, lobby.variant),
        lobby.avgRank,
        lobbyId,
      );

      await this.redis.zadd(
        getMatchmakingQueueCacheKey(lobby.type, region, lobby.variant),
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

    // Standard queues report under their bare match type exactly as before;
    // Captain Pick gets its own key so the two 5v5 counts never mix. Older
    // web builds only read the match-type keys and ignore the extra one.
    const queues: Array<{
      type: e_match_types_enum;
      variant: MatchmakingQueueVariant;
    }> = [
      ...types.map((type) => ({ type, variant: "Standard" as const })),
      { type: "Competitive", variant: "CaptainPick" },
    ];

    const regionStats: Partial<
      Record<
        string,
        Partial<Record<string, Array<{ index: number; size: number }>>>
      >
    > = {};

    for (const { type, variant } of queues) {
      const statsKey = getMatchmakingRegionStatsKey(type, variant);
      const lobbyIndexes = new Map<string, number>();
      // A lobby can appear in more than one region's zset (multi-region
      // search), so its player count is only worth fetching once per queue.
      const lobbySizes = new Map<string, number>();

      for (const region of regions.server_regions) {
        const lobbyIds = await this.redis.zrange(
          getMatchmakingQueueCacheKey(type, region.value, variant),
          0,
          -1,
        );

        const stats = (regionStats[region.value] ??= {});
        const entries = await Promise.all(
          lobbyIds.map(async (lobbyId) => {
            let size = lobbySizes.get(lobbyId);
            if (size === undefined) {
              const lobby =
                await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

              if (!lobby) {
                // Orphaned queue entry: still zadd'd into this region/type's
                // zset, but its details hash is gone -- getLobbyDetails can
                // never resolve regions to clean it up via the normal
                // removeLobbyFromQueue path (that needs the very details
                // that are missing), so it would otherwise sit in the queue
                // forever, inflating "N in queue" by a phantom player with
                // no way to ever leave. Self-heal it here instead, since
                // this loop already has the exact (type, region) pair that
                // needs the zrem.
                await this.redis.zrem(
                  getMatchmakingQueueCacheKey(type, region.value, variant),
                  lobbyId,
                );
                await this.redis.zrem(
                  getMatchmakingRankCacheKey(type, region.value, variant),
                  lobbyId,
                );
                lobbySizes.set(lobbyId, 0);
                return null;
              }

              size = lobby.players.length;
              lobbySizes.set(lobbyId, size);
            }

            if (size === 0) {
              return null;
            }

            let index = lobbyIndexes.get(lobbyId);
            if (index === undefined) {
              index = lobbyIndexes.size;
              lobbyIndexes.set(lobbyId, index);
            }

            return { index, size };
          }),
        );
        stats[statsKey] = entries.filter(
          (entry): entry is { index: number; size: number } => entry !== null,
        );
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

    // Queue order decides who gets into the next match, not rank -- a
    // rank-similarity gate meant someone in a thin ELO bracket could wait
    // indefinitely while more common brackets kept matching quickly, even
    // though they'd been queuing far longer. Whoever's been waiting longest
    // gets pulled in first; createMatches already finds the best-possible
    // ELO-balanced split (splitIntoBalancedTeams) across whichever lobbies
    // end up selected, so balance is still the goal, just not a queue gate.
    lobbies = lobbies.sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
    );

    // Nobody already in a match, a draft or a ready check, and nobody twice.
    lobbies = await this.withoutBusyLobbies(lobbies);

    if (lobbies.length === 0) {
      await this.releaseMatchmakeRegionLock(region);
      return;
    }

    const totalPlayerNotQueued = await this.createMatches(
      region,
      type,
      lobbies,
    ).finally(() => {
      void this.releaseMatchmakeRegionLock(region);
    });

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

  /** Runs the matchmaker for one queue: Standard or Captain Pick. */
  public async matchmakeQueue(
    type: e_match_types_enum,
    region: string,
    variant: MatchmakingQueueVariant = "Standard",
  ): Promise<void> {
    if (variant === "CaptainPick") {
      await this.matchmakeCaptainPick(region);
      return;
    }

    await this.matchmake(type, region);
  }

  /**
   * Captain Pick queue: ten solo players in queue order become one ready
   * check. No team split happens here; teams are drafted after 10/10 Ready.
   * Runs under its own region lock and only ever reads Captain Pick keys.
   */
  public async matchmakeCaptainPick(region: string): Promise<void> {
    const lock = await this.aquireMatchmakeRegionLock(region, "CaptainPick");
    if (!lock) {
      this.logger.warn(
        `Unable to acquire captain pick region lock for ${region} - another matchmaking process is running`,
      );
      return;
    }

    try {
      const lobbyIds = await this.redis.zrange(
        getMatchmakingRankCacheKey("Competitive", region, "CaptainPick"),
        0,
        -1,
      );

      const lobbies: Array<MatchmakingLobby> = [];
      for (const lobbyId of lobbyIds) {
        const details =
          await this.matchmakingLobbyService.getLobbyDetails(lobbyId);
        if (details) {
          lobbies.push(details);
        }
      }

      if (lobbies.length === 0) {
        return;
      }

      // Turning the feature off stops new drafts from forming. Anyone still
      // waiting is taken out of the queue and told why, rather than left
      // searching forever. Drafts already committed are unaffected.
      if (!(await this.captainPickSettings.getSettings()).enabled) {
        for (const lobby of lobbies) {
          await this.removeLobbyWithError(
            lobby.lobbyId,
            CAPTAIN_PICK_DISABLED_ERROR,
          );
        }
        return;
      }

      let eligible: Array<MatchmakingLobby> = [];
      for (const lobby of lobbies) {
        if (
          resolveMatchmakingQueueVariant(lobby.variant) === "CaptainPick" &&
          lobby.type === "Competitive" &&
          lobby.players.length === 1
        ) {
          eligible.push(lobby);
        } else {
          this.logger.warn(
            `Removing lobby ${lobby.lobbyId} from the captain pick queue - not a solo captain pick lobby`,
          );
          await this.removeLobbyWithError(
            lobby.lobbyId,
            CAPTAIN_PICK_SOLO_ONLY_ERROR,
          );
        }
      }

      eligible.sort(
        (a, b) =>
          new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime(),
      );

      // Anyone already in a match, a draft or another ready check is dropped
      // from the queue here instead of being pulled into a second one.
      eligible = await this.withoutBusyLobbies(eligible);

      while (eligible.length >= CAPTAIN_PICK_PLAYER_COUNT) {
        const claimed: Array<MatchmakingLobby> = [];

        while (
          claimed.length < CAPTAIN_PICK_PLAYER_COUNT &&
          eligible.length > 0
        ) {
          const lobby = eligible.shift();
          if (await this.claimLobby(lobby.lobbyId, lobby)) {
            claimed.push(lobby);
          }
        }

        if (claimed.length < CAPTAIN_PICK_PLAYER_COUNT) {
          for (const lobby of claimed) {
            await this.releaseLobbyAndRequeue(lobby.lobbyId);
          }
          break;
        }

        try {
          const created = await this.createCaptainPickConfirmation(
            region,
            claimed,
          );
          if (created === false) {
            // The conflicting lobbies were dropped and the rest requeued;
            // another pass forms the draft from whoever is left.
            setTimeout(() => {
              void this.matchmakeCaptainPick(region);
            }, 2000);
            break;
          }
        } catch (error) {
          this.logger.error(
            `Error creating captain pick confirmation in ${region}:`,
            error,
          );
          for (const lobby of claimed) {
            await this.releaseLobbyAndRequeue(lobby.lobbyId);
          }
          break;
        }
      }
    } finally {
      await this.releaseMatchmakeRegionLock(region, "CaptainPick");
    }
  }

  private async removeLobbyWithError(lobbyId: string, message: string) {
    const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);

    await this.matchmakingLobbyService.removeLobbyFromQueue(lobbyId);
    await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);

    for (const player of lobby?.players ?? []) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:error",
          data: { message },
        }),
      );
    }
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

      // Only Standard lobbies may ever reach the automatic balancing below.
      // A Captain Pick (or unknown) lobby showing up here would otherwise be
      // auto-balanced into a normal match instead of drafted.
      if (resolveMatchmakingQueueVariant(details.variant) !== "Standard") {
        this.logger.warn(
          `Skipping lobby ${details.lobbyId} - ${details.variant} lobbies are not matched by the standard matchmaker`,
        );
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

    // check if we have a full match's worth of players, AND those players
    // can actually be split into two even teams. Parties are atomic (never
    // split across teams), so player count alone isn't enough — e.g. five
    // 2-player parties total 10 (a full Competitive match) but can never
    // form two teams of 5, since 5 isn't reachable by summing 2s. Without
    // this check that case fell through to splitIntoBalancedTeams, which
    // assumed a split always exists and silently produced a broken 0v10
    // match instead.
    if (
      selectedPlayerCount === requiredPlayers &&
      this.canFillTeams(
        selectedLobbies.map((lobby) => lobby.players.length),
        playersPerTeam,
      )
    ) {
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

        const created = await this.createMatchConfirmation(region, type, {
          team1,
          team2,
        });
        if (created === false) {
          // Conflicting lobbies were dropped and the rest requeued.
          totalPlayerNotQueued = team1.players.length + team2.players.length;
        }
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

  // Whether some subset of `partySizes` (each atomic — a party never splits
  // across teams) sums to exactly `teamSize`. Since the caller only checks
  // this once the total is exactly 2 * teamSize, a subset hitting teamSize
  // guarantees the complement does too, so checking for one reachable value
  // is enough. Subset-sum via a small reachable-sums DP — the pool is at
  // most one match's worth of parties, so this is cheap.
  private canFillTeams(partySizes: number[], teamSize: number): boolean {
    const reachable = new Set<number>([0]);
    for (const size of partySizes) {
      for (const sum of [...reachable]) {
        const next = sum + size;
        if (next <= teamSize) {
          reachable.add(next);
        }
      }
    }
    return reachable.has(teamSize);
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

  private async aquireMatchmakeRegionLock(
    region: string,
    variant: MatchmakingQueueVariant = "Standard",
  ): Promise<boolean> {
    const lockKey = getMatchmakingRegionLockKey(region, variant);

    const result = await this.redis.set(lockKey, 1, "EX", 60, "NX");

    if (result === null) {
      return false;
    }

    return true;
  }

  private async releaseMatchmakeRegionLock(
    region: string,
    variant: MatchmakingQueueVariant = "Standard",
  ) {
    const lockKey = getMatchmakingRegionLockKey(region, variant);
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
      keys.push(getMatchmakingQueueCacheKey(lobby.type, region, lobby.variant));
      keys.push(getMatchmakingRankCacheKey(lobby.type, region, lobby.variant));
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
  ): Promise<boolean> {
    if (!region) {
      throw new Error("Region is required");
    }
    const { team1, team2 } = players;

    const allLobbies = new Set([...team1.lobbies, ...team2.lobbies]);
    const confirmationId = uuidv4();

    // A player already in a match, a draft or another ready check must not
    // be pulled into this one. Their lobby is dropped, everyone else requeued.
    const conflicts = await this.claimPlayersForConfirmation(
      confirmationId,
      [...team1.players, ...team2.players].map((player) => player.steam_id),
    );
    if (conflicts.length > 0) {
      const busy = new Set(conflicts);
      for (const lobbyId of allLobbies) {
        const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);
        if (lobby && this.lobbyHasBusyPlayer(lobby, busy)) {
          await this.dropLobbyWithBusyPlayers(lobby, busy);
        } else {
          await this.releaseLobbyAndRequeue(lobbyId);
        }
      }
      return false;
    }

    for (const lobbyId of allLobbies) {
      void this.releaseLobbyLock(lobbyId, 30);
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + 30);

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

    await this.broadcastRegionStatsAfterClaim();

    const steamIds = [...team1.players, ...team2.players].map(
      (p) => p.steam_id,
    );
    this.pushNotifications
      .sendMatchFound(steamIds, {
        title: "Match found",
        body: "Tap to accept your match.",
        entityId: confirmationId,
      })
      .catch((error) =>
        this.logger.warn(
          `[matchmaking] push match-found notification failed: ${(error as Error)?.message}`,
        ),
      );

    return true;
  }

  /**
   * Same ready check as Standard, but for ten individual candidates: no
   * teams are assigned. Everything the draft (or a failed-ready requeue)
   * needs is stored on the confirmation itself.
   */
  private async createCaptainPickConfirmation(
    region: string,
    lobbies: Array<MatchmakingLobby>,
  ): Promise<boolean> {
    if (!region) {
      throw new Error("Region is required");
    }

    const confirmationId = uuidv4();

    // Same guard as Standard: nobody already in a match, a draft or another
    // ready check is allowed into this one.
    const conflicts = await this.claimPlayersForConfirmation(
      confirmationId,
      lobbies.flatMap((lobby) => lobby.players.map((player) => player.steam_id)),
    );
    if (conflicts.length > 0) {
      const busy = new Set(conflicts);
      for (const lobby of lobbies) {
        if (this.lobbyHasBusyPlayer(lobby, busy)) {
          await this.dropLobbyWithBusyPlayers(lobby, busy);
        } else {
          await this.releaseLobbyAndRequeue(lobby.lobbyId);
        }
      }
      return false;
    }

    for (const lobby of lobbies) {
      void this.releaseLobbyLock(lobby.lobbyId, 30);
    }

    const lobbyIds = lobbies.map((lobby) => lobby.lobbyId);
    const participants = lobbies.map((lobby) => ({
      steam_id: lobby.players[0].steam_id,
      lobbyId: lobby.lobbyId,
      joinedAt: new Date(lobby.joinedAt).toISOString(),
    }));

    await this.redis.hset(getMatchmakingConformationCacheKey(confirmationId), {
      type: "Competitive",
      variant: "CaptainPick",
      region,
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
      lobbyIds: JSON.stringify(lobbyIds),
      participants: JSON.stringify(participants),
      team1: "[]",
      team2: "[]",
    });

    for (const lobbyId of lobbyIds) {
      await this.matchmakingLobbyService.setMatchConformationIdForLobby(
        lobbyId,
        confirmationId,
      );
      await this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
    }

    await this.cancelMatchMakingDueToReadyCheck(confirmationId);

    await this.broadcastRegionStatsAfterClaim();

    this.pushNotifications
      .sendMatchFound(
        participants.map(({ steam_id }) => steam_id),
        {
          title: "Match found",
          body: "Tap to accept your match.",
          entityId: confirmationId,
        },
      )
      .catch((error) =>
        this.logger.warn(
          `[matchmaking] push match-found notification failed: ${(error as Error)?.message}`,
        ),
      );

    return true;
  }

  // ---- One player, one ready check -------------------------------------
  //
  // A player can end up with two queue entries (e.g. a party lobby and a solo
  // one) and be matched into two ready checks, accepting both. These helpers
  // make sure a player is only ever part of one match/draft/ready check.

  private static readonly PLAYER_CLAIM_TTL_SECONDS = 180;

  private static readonly RELEASE_PLAYER_CLAIM_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;

  public getConfirmationSteamIds(details: {
    variant: MatchmakingQueueVariant;
    team1: Array<{ steam_id: string }>;
    team2: Array<{ steam_id: string }>;
    participants: Array<{ steam_id: string }>;
  }): string[] {
    const players =
      details.variant === "CaptainPick"
        ? details.participants
        : [...details.team1, ...details.team2];

    return players.map((player) => String(player.steam_id));
  }

  /**
   * Players that cannot be put into a (new) ready check: already in a live
   * match, in a Captain Pick draft, or in a different ready check than
   * `confirmationId`. A failed lookup never blocks matchmaking.
   */
  public async getBusySteamIds(
    steamIds: string[],
    confirmationId?: string,
  ): Promise<Set<string>> {
    const busy = new Set<string>();
    const ids = [...new Set(steamIds.map(String))];

    if (ids.length === 0) {
      return busy;
    }

    try {
      const result = await this.hasura.query({
        players: {
          __args: { where: { steam_id: { _in: ids } } },
          steam_id: true,
          is_in_another_match: true,
        },
      });
      for (const player of result?.players ?? []) {
        if (player.is_in_another_match) {
          busy.add(String(player.steam_id));
        }
      }
    } catch (error) {
      this.logger.warn(
        `[matchmaking] could not check which players are already in a match: ${(error as Error)?.message}`,
      );
    }

    for (const steamId of ids) {
      if (busy.has(steamId)) {
        continue;
      }

      try {
        // A draft id is its confirmation id, so this ready check's own
        // (already started) draft is not a conflict.
        const draftId = await this.captainPick.getActiveDraftId(steamId);
        if (draftId && draftId !== confirmationId) {
          busy.add(steamId);
          continue;
        }

        const claim = await this.redis.get(getMatchmakingPlayerClaimKey(steamId));
        if (claim && claim !== confirmationId) {
          busy.add(steamId);
        }
      } catch (error) {
        this.logger.warn(
          `[matchmaking] could not check ready check/draft state for ${steamId}: ${(error as Error)?.message}`,
        );
      }
    }

    return busy;
  }

  /**
   * Marks these players as part of `confirmationId`. Returns the players that
   * could not be claimed (busy); when there are any, nothing stays claimed.
   */
  private async claimPlayersForConfirmation(
    confirmationId: string,
    steamIds: string[],
  ): Promise<string[]> {
    const busy = await this.getBusySteamIds(steamIds, confirmationId);
    const claimed: string[] = [];

    for (const steamId of [...new Set(steamIds.map(String))]) {
      if (busy.has(steamId)) {
        continue;
      }

      const ok = await this.redis.set(
        getMatchmakingPlayerClaimKey(steamId),
        confirmationId,
        "EX",
        MatchmakeService.PLAYER_CLAIM_TTL_SECONDS,
        "NX",
      );

      if (ok === "OK") {
        claimed.push(steamId);
      } else {
        busy.add(steamId);
      }
    }

    if (busy.size > 0) {
      await this.releasePlayerClaims(confirmationId, claimed);
      this.logger.warn(
        `[matchmaking] ready check ${confirmationId} refused: ${[...busy].join(", ")} already in a match, draft or ready check`,
      );
    }

    return [...busy];
  }

  private async releasePlayerClaims(
    confirmationId: string,
    steamIds: string[],
  ): Promise<void> {
    for (const steamId of steamIds) {
      await this.redis.eval(
        MatchmakeService.RELEASE_PLAYER_CLAIM_SCRIPT,
        1,
        getMatchmakingPlayerClaimKey(steamId),
        confirmationId,
      );
    }
  }

  private lobbyHasBusyPlayer(
    lobby: { players: Array<{ steam_id: string }> },
    busy: Set<string>,
  ): boolean {
    return lobby.players.some((player) => busy.has(String(player.steam_id)));
  }

  /**
   * Takes a lobby with a busy player out of the queue. The busy player gets
   * no event (their other match/ready check owns their screen); the rest of
   * the lobby is told why and sent back to the start.
   */
  private async dropLobbyWithBusyPlayers(
    lobby: { lobbyId: string; players: Array<{ steam_id: string }> },
    busy: Set<string>,
  ): Promise<void> {
    await this.matchmakingLobbyService.removeLobbyFromQueue(lobby.lobbyId);
    await this.matchmakingLobbyService.removeLobbyDetailsQuietly(lobby.lobbyId);
    await this.releaseLobbyLock(lobby.lobbyId, 0);

    for (const player of lobby.players) {
      if (busy.has(String(player.steam_id))) {
        continue;
      }

      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:error",
          data: { message: "A player in your lobby is already in a match" },
        }),
      );
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: player.steam_id,
          event: "matchmaking:details",
          data: {},
        }),
      );
    }
  }

  private async withoutBusyLobbies(
    lobbies: Array<MatchmakingLobby>,
  ): Promise<Array<MatchmakingLobby>> {
    const busy = await this.getBusySteamIds(
      lobbies.flatMap((lobby) => lobby.players.map((player) => player.steam_id)),
    );

    // The same player queued twice (two lobbies): the first entry stays, the
    // later one is dropped, so one player never fills two seats.
    const seen = new Set<string>();
    const kept: Array<MatchmakingLobby> = [];
    for (const lobby of lobbies) {
      const ids = lobby.players.map((player) => String(player.steam_id));
      const duplicates = ids.filter((id) => seen.has(id));
      const unavailable = new Set([
        ...duplicates,
        ...ids.filter((id) => busy.has(id)),
      ]);

      if (unavailable.size > 0) {
        await this.dropLobbyWithBusyPlayers(lobby, unavailable);
      } else {
        ids.forEach((id) => seen.add(id));
        kept.push(lobby);
      }
    }

    return kept;
  }

  /**
   * Ends a ready check because some of its players turned out to be in
   * another match/draft: they are told and dropped, everyone else who had
   * already accepted goes back in the queue (cancelMatchMaking).
   */
  private async abortConfirmationForBusyPlayers(
    confirmationId: string,
    busy: Set<string>,
    lobbyIds: string[],
  ): Promise<void> {
    const confirmedKey = `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`;

    for (const steamId of busy) {
      await this.redis.hdel(confirmedKey, steamId);
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: "matchmaking:error",
          data: { message: "You are already in a match" },
        }),
      );
    }

    for (const lobbyId of lobbyIds) {
      const lobby = await this.matchmakingLobbyService.getLobbyDetails(lobbyId);
      if (lobby && this.lobbyHasBusyPlayer(lobby, busy)) {
        await this.dropLobbyWithBusyPlayers(lobby, busy);
      }
    }

    this.logger.warn(
      `[matchmaking] ready check ${confirmationId} canceled: ${[...busy].join(", ")} already in a match or draft`,
    );

    await this.cancelMatchMaking(confirmationId);
  }

  /**
   * claimLobby already took these lobbies out of the queue zsets, but every
   * client's "Play" badge still shows the count broadcast when they joined.
   * Re-broadcast so players in a ready check (and later the draft/match) stop
   * counting as searching. A failed broadcast must never undo the ready
   * check (callers requeue on throw), so it is only logged.
   */
  private async broadcastRegionStatsAfterClaim() {
    try {
      await this.sendRegionStats();
    } catch (error) {
      this.logger.warn(
        `[matchmaking] region stats broadcast after match found failed: ${(error as Error)?.message}`,
      );
    }
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
    // The ready check is over, so its players are free to join another.
    const ending = await this.getMatchConfirmationDetails(confirmationId);
    await this.releasePlayerClaims(
      confirmationId,
      this.getConfirmationSteamIds(ending),
    );

    const confirmedKey = `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`;
    await this.redis.del(confirmedKey);

    await this.redis.del(getMatchmakingConformationCacheKey(confirmationId));

    // A Captain Pick confirmation only ends with its match (or its ready
    // check failing), so the draft and its player keys go with it.
    await this.captainPick.cleanup(confirmationId);
  }

  public async getMatchConfirmationDetails(confirmationId: string): Promise<{
    type: e_match_types_enum;
    variant: MatchmakingQueueVariant;
    region: string;
    lobbyIds: string[];
    team1: { steam_id: string; rank: number }[];
    team2: { steam_id: string; rank: number }[];
    participants: { steam_id: string; lobbyId: string; joinedAt: string }[];
    matchId: string;
    expiresAt: string;
    confirmed: string[];
  }> {
    const {
      type,
      variant,
      region,
      lobbyIds,
      team1,
      team2,
      participants,
      matchId,
      expiresAt,
    } = await this.redis.hgetall(
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
      variant: resolveMatchmakingQueueVariant(variant) ?? "Standard",
      team1: JSON.parse(team1 || "[]"),
      team2: JSON.parse(team2 || "[]"),
      participants: JSON.parse(participants || "[]"),
      lobbyIds: JSON.parse(lobbyIds || "[]"),
      confirmed: Object.keys(confirmed),
    };
  }

  // Players the ready check is waiting on: the two pre-balanced teams for
  // Standard, the ten undrafted candidates for Captain Pick.
  public getConfirmationPlayerCount(details: {
    variant: MatchmakingQueueVariant;
    team1: unknown[];
    team2: unknown[];
    participants: unknown[];
  }): number {
    return details.variant === "CaptainPick"
      ? details.participants.length
      : details.team1.length + details.team2.length;
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
    const details = await this.getMatchConfirmationDetails(confirmationId);
    const { lobbyIds, type, region, variant } = details;

    // Once all ten accepted, a Captain Pick group is committed: the ready
    // check can no longer cancel it. A late (stale) ready-check job either
    // finds the draft already running, or finds a 10/10 group whose draft
    // never got started (crash right after the claim) and starts it.
    if (!hasMatch && variant === "CaptainPick") {
      if (await this.captainPick.hasDraft(confirmationId)) {
        return;
      }

      const total = this.getConfirmationPlayerCount(details);
      if (total > 0 && details.confirmed.length >= total) {
        await this.captainPick.startDraft(confirmationId);
        return;
      }
    }

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
          void this.matchmakeQueue(type, region, variant);
        },
        Math.floor(Math.random() * 10000),
      );
    }
  }

  public async playerConfirmMatchmaking(
    confirmationId: string,
    steamId: string,
  ) {
    // Whoever is already in a match, a draft or another ready check cannot
    // accept this one. Ending it here protects the nine other players from
    // waiting on someone who can never join.
    const before = await this.getMatchConfirmationDetails(confirmationId);
    if (
      this.getConfirmationSteamIds(before).includes(String(steamId)) &&
      // A late accept after the match/draft exists is not a double booking:
      // the player is in this very match.
      !before.matchId &&
      !(await this.captainPick.hasDraft(confirmationId))
    ) {
      const busy = await this.getBusySteamIds([steamId], confirmationId);
      if (busy.size > 0) {
        await this.abortConfirmationForBusyPlayers(
          confirmationId,
          busy,
          before.lobbyIds,
        );
        return;
      }
    }

    await this.redis.hset(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
      steamId,
      1,
    );

    const details = await this.getMatchConfirmationDetails(confirmationId);
    const { lobbyIds, confirmed } = details;

    if (confirmed.length != this.getConfirmationPlayerCount(details)) {
      for (const lobbyId of lobbyIds) {
        void this.matchmakingLobbyService.sendQueueDetailsToLobby(lobbyId);
      }
      return;
    }

    // playerConfirmMatchmaking runs once per player confirming, so the
    // last few players confirming near-simultaneously can each read
    // "everyone's confirmed" before any of them has created the match --
    // producing duplicate matches for the same lobbies (seen live: 3
    // matches for one lobby, only one of which ever got a map). This SET
    // NX is the single source of truth for "has this confirmation already
    // produced a match" -- only the caller that wins it proceeds.
    const claimed = await this.redis.set(
      `${getMatchmakingConformationCacheKey(confirmationId)}:match-claimed`,
      1,
      "EX",
      300,
      "NX",
    );
    if (!claimed) {
      return;
    }

    // Last gate before a draft/match is built: only the caller that won the
    // claim gets here, so a late accept of an already-created match is never
    // mistaken for a double booking.
    const alreadyBuilt =
      !!details.matchId || (await this.captainPick.hasDraft(confirmationId));
    if (!alreadyBuilt) {
      const busy = await this.getBusySteamIds(
        this.getConfirmationSteamIds(details),
        confirmationId,
      );
      if (busy.size > 0) {
        await this.abortConfirmationForBusyPlayers(
          confirmationId,
          busy,
          lobbyIds,
        );
        return;
      }
    }

    // 10/10 is the Captain Pick commitment point: the ready check is over
    // for this group and the draft takes it from here.
    // If starting the draft throws, the ready-check job is still there and
    // will start it (see cancelMatchMaking); only remove it once it's done.
    if (details.variant === "CaptainPick") {
      await this.captainPick.startDraft(confirmationId);
      await this.removeCancelMatchMakingJob(confirmationId);
      return;
    }

    await this.createMatch(confirmationId);
  }

  private async createMatch(confirmationId: string) {
    const { team1, team2, type, region, lobbyIds, variant } =
      await this.getMatchConfirmationDetails(confirmationId);

    // Captain Pick teams come from the draft, never from here.
    if (variant !== "Standard") {
      throw new Error(
        `refusing to auto-create a ${variant} match for ${confirmationId}`,
      );
    }

    await this.removeCancelMatchMakingJob(confirmationId);

    const { mapPoolType, options } = getMatchmakingMatchSetup(type, region);
    const match = await this.matchAssistant.createMatchBasedOnType(
      type,
      mapPoolType,
      options,
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
