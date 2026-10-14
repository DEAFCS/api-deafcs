import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { CacheService } from "src/cache/cache.service";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";

// Real Redis (the Lua script and the queue checks), against a disposable
// local container only:
//   docker run -d --rm --name deafcs-test-redis-queue \
//     -p 127.0.0.1:16399:6379 redis:7-alpine
//   MATCHMAKING_REDIS_TEST_PORT=16399 npx jest matchmaking-queue-race.redis
// The database is flushed between tests, so it must never be a shared one.
const enabled = process.env.MATCHMAKING_REDIS_TEST_PORT === "16399";
const describeRedis = enabled ? describe : describe.skip;

describeRedis("matchmaking queue race (real Redis)", () => {
  let redis: Redis;
  let matchmake: MatchmakeService;
  let lobbies: MatchmakingLobbyService;
  let cache: CacheService;
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

  const details = (
    lobbyId: string,
    type: MatchmakingLobby["type"],
    regions: string[],
    variant?: MatchmakingLobby["variant"],
  ): MatchmakingLobby => ({
    lobbyId,
    type,
    ...(variant ? { variant } : {}),
    regions,
    joinedAt: new Date(),
    players: [{ steam_id: "1", rank: 5000 }],
    avgRank: 5000,
    regionPositions: {},
  });

  // What setLobbyDetails + addLobbyToQueue leave in Redis.
  async function queue(lobby: MatchmakingLobby) {
    await redis.hset(
      getMatchmakingLobbyDetailsCacheKey(lobby.lobbyId),
      "details",
      JSON.stringify(lobby),
    );
    for (const region of lobby.regions) {
      await redis.zadd(
        getMatchmakingQueueCacheKey(lobby.type, region, lobby.variant),
        0,
        lobby.lobbyId,
      );
      await redis.zadd(
        getMatchmakingRankCacheKey(lobby.type, region, lobby.variant),
        lobby.avgRank,
        lobby.lobbyId,
      );
    }
  }

  // An entry with no details behind it (the old mode's leftover).
  async function strayEntry(
    lobbyId: string,
    type: MatchmakingLobby["type"],
    region: string,
    variant?: MatchmakingLobby["variant"],
  ) {
    await redis.zadd(getMatchmakingQueueCacheKey(type, region, variant), 0, lobbyId);
    await redis.zadd(getMatchmakingRankCacheKey(type, region, variant), 0, lobbyId);
  }

  const inQueue = async (
    lobbyId: string,
    type: MatchmakingLobby["type"],
    region: string,
    variant?: MatchmakingLobby["variant"],
  ) =>
    (await redis.zscore(getMatchmakingQueueCacheKey(type, region, variant), lobbyId)) !==
      null &&
    (await redis.zscore(getMatchmakingRankCacheKey(type, region, variant), lobbyId)) !==
      null;

  const drop = (
    lobbyId: string,
    type: MatchmakingLobby["type"],
    variant: "Standard" | "CaptainPick",
    regions: string[],
  ) => (matchmake as any).dropStrayQueueEntries(lobbyId, type, variant, regions);

  beforeAll(() => {
    redis = new Redis({ host: "127.0.0.1", port: 16399, lazyConnect: false });
    const manager = { getConnection: () => redis } as any;
    matchmake = Object.create(MatchmakeService.prototype);
    Object.assign(matchmake, { redis, logger });
    lobbies = Object.create(MatchmakingLobbyService.prototype);
    Object.assign(lobbies, { redis, logger });
    cache = new CacheService(manager, logger as unknown as Logger);
  });

  beforeEach(async () => {
    await redis.flushdb();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  describe("stray-entry script", () => {
    it("drops the old mode's entry after a switch and keeps the new one", async () => {
      await strayEntry("lobby-1", "Competitive", "EU");
      await queue(details("lobby-1", "Wingman", ["EU"]));

      expect(await drop("lobby-1", "Competitive", "Standard", ["EU"])).toBe(true);

      expect(await inQueue("lobby-1", "Competitive", "EU")).toBe(false);
      expect(await inQueue("lobby-1", "Wingman", "EU")).toBe(true);
    });

    it("never removes an entry the current details still justify (a newer valid join)", async () => {
      await queue(details("lobby-1", "Competitive", ["EU"]));

      expect(await drop("lobby-1", "Competitive", "Standard", ["EU"])).toBe(false);
      expect(await inQueue("lobby-1", "Competitive", "EU")).toBe(true);
    });

    it("keeps Captain Pick and Standard 5v5 apart", async () => {
      // Queued for Captain Pick, with a leftover Standard 5v5 entry.
      await strayEntry("lobby-1", "Competitive", "EU");
      await queue(details("lobby-1", "Competitive", ["EU"], "CaptainPick"));

      expect(await drop("lobby-1", "Competitive", "CaptainPick", ["EU"])).toBe(false);
      expect(await drop("lobby-1", "Competitive", "Standard", ["EU"])).toBe(true);
      expect(await inQueue("lobby-1", "Competitive", "EU", "CaptainPick")).toBe(true);
      expect(await inQueue("lobby-1", "Competitive", "EU")).toBe(false);

      // And the other way round.
      await strayEntry("lobby-2", "Competitive", "EU", "CaptainPick");
      await queue(details("lobby-2", "Competitive", ["EU"]));
      expect(await drop("lobby-2", "Competitive", "CaptainPick", ["EU"])).toBe(true);
      expect(await drop("lobby-2", "Competitive", "Standard", ["EU"])).toBe(false);
      expect(await inQueue("lobby-2", "Competitive", "EU")).toBe(true);
    });

    it("drops a region the lobby no longer searches, keeping the others", async () => {
      await strayEntry("lobby-1", "Duel", "NA");
      await queue(details("lobby-1", "Duel", ["EU"]));

      expect(await drop("lobby-1", "Duel", "Standard", ["EU", "NA"])).toBe(true);
      expect(await inQueue("lobby-1", "Duel", "EU")).toBe(true);
      expect(await inQueue("lobby-1", "Duel", "NA")).toBe(false);
    });

    it("drops an orphaned entry whose details are gone", async () => {
      await strayEntry("gone", "Wingman", "EU");
      expect(await drop("gone", "Wingman", "Standard", ["EU"])).toBe(true);
      expect(await inQueue("gone", "Wingman", "EU")).toBe(false);
    });

    it("leaves other lobbies alone", async () => {
      await queue(details("lobby-1", "Wingman", ["EU"]));
      await queue(details("lobby-2", "Competitive", ["EU"]));
      await drop("lobby-1", "Competitive", "Standard", ["EU"]);
      expect(await inQueue("lobby-2", "Competitive", "EU")).toBe(true);
    });
  });

  describe("isLobbyQueued", () => {
    it("is true only while the lobby is actually in one of its queues", async () => {
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(false);
      await queue(details("lobby-1", "Competitive", ["EU", "NA"]));
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(true);

      // A details record left behind with no queue entry is not "queued":
      // it must never keep a lobby out of matchmaking.
      await redis.zrem(getMatchmakingQueueCacheKey("Competitive", "EU"), "lobby-1");
      await redis.zrem(getMatchmakingQueueCacheKey("Competitive", "NA"), "lobby-1");
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(false);
    });

    it("is true for Captain Pick under its own keys", async () => {
      await queue(details("lobby-1", "Competitive", ["EU"], "CaptainPick"));
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(true);
    });

    it("is true during a live ready check and while claimed, not after", async () => {
      await redis.hset(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "details",
        JSON.stringify(details("lobby-1", "Competitive", ["EU"])),
      );
      await redis.set("matchmaking:lock:lobby-1", 1, "EX", 10);
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(true);
      await redis.del("matchmaking:lock:lobby-1");

      await redis.hset(
        getMatchmakingLobbyDetailsCacheKey("lobby-1"),
        "confirmationId",
        "c-1",
      );
      await redis.hset(getMatchmakingConformationCacheKey("c-1"), "type", "Competitive");
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(true);

      // The ready check is over but its id was left on the lobby.
      await redis.del(getMatchmakingConformationCacheKey("c-1"));
      expect(await lobbies.isLobbyQueued("lobby-1")).toBe(false);
    });
  });

  describe("two joins for one lobby at once", () => {
    // The gateway's critical section: verify, refuse if queued, then queue.
    // Run twice concurrently through the real lock.
    const join = (lobby: MatchmakingLobby) =>
      cache
        .lock(`matchmaking:verify:${lobby.lobbyId}`, async () => {
          if (await lobbies.isLobbyQueued(lobby.lobbyId)) {
            return "already_queued";
          }
          // the join's real work takes a moment
          await new Promise((resolve) => setTimeout(resolve, 50));
          await queue(lobby);
          return "queued";
        })
        .then((result) => result as string);

    it("different modes: exactly one wins and the lobby is in one queue", async () => {
      const results = await Promise.all([
        join(details("lobby-1", "Competitive", ["EU"])),
        join(details("lobby-1", "Wingman", ["EU"])),
      ]);

      expect(results.sort()).toEqual(["already_queued", "queued"]);
      const competitive = await inQueue("lobby-1", "Competitive", "EU");
      const wingman = await inQueue("lobby-1", "Wingman", "EU");
      expect(competitive !== wingman).toBe(true);
    });

    it("identical joins: one entry, the second refused", async () => {
      const lobby = details("lobby-1", "Duel", ["EU"]);
      const results = await Promise.all([join(lobby), join(lobby)]);
      expect(results.sort()).toEqual(["already_queued", "queued"]);
      expect(
        await redis.zcard(getMatchmakingQueueCacheKey("Duel", "EU")),
      ).toBe(1);
    });

    it("cancel then rejoin is allowed, and the old entry is gone", async () => {
      await join(details("lobby-1", "Competitive", ["EU"]));
      // matchmaking:leave
      await redis.zrem(getMatchmakingQueueCacheKey("Competitive", "EU"), "lobby-1");
      await redis.zrem(getMatchmakingRankCacheKey("Competitive", "EU"), "lobby-1");
      await redis.hdel(getMatchmakingLobbyDetailsCacheKey("lobby-1"), "details");

      expect(await join(details("lobby-1", "Wingman", ["EU"]))).toBe("queued");
      expect(await inQueue("lobby-1", "Competitive", "EU")).toBe(false);
      expect(await inQueue("lobby-1", "Wingman", "EU")).toBe(true);
    });
  });
});
