import { Logger } from "@nestjs/common";

jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { MatchmakingQueueVariant } from "./types/MatchmakingQueueVariant";
import { FakeQueue, FakeRedis } from "../../test/mocks/fake-redis";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import { e_match_types_enum } from "generated";

// The sidebar "Play" badge is the matchmaking:region-stats broadcast summed
// per queue entry (deafcs-web MatchmakingStore.totalQueuedPlayers). These
// specs pin what that broadcast counts across the match-found lifecycle.

const REGION = "Europe";
const T0 = new Date("2026-10-01T18:00:00.000Z").getTime();

let nextId = 0;
const lobby = (
  type: e_match_types_enum = "Competitive",
  variant: MatchmakingQueueVariant = "Standard",
): MatchmakingLobby => {
  const n = ++nextId;
  const steamId = `7656119800000${String(n).padStart(4, "0")}`;
  return {
    type,
    variant,
    regions: [REGION],
    joinedAt: new Date(T0 + n * 1000),
    lobbyId: steamId,
    players: [{ steam_id: steamId, rank: 5000 }],
    regionPositions: {},
    avgRank: 5000,
  };
};

describe("MatchmakeService Play count (region stats)", () => {
  let redis: FakeRedis;
  let queue: FakeQueue;
  let service: MatchmakeService;
  let details: Map<string, MatchmakingLobby>;
  let captainPick: Record<string, jest.Mock>;
  let logger: Logger;

  const queueLobbies = async (lobbies: Array<MatchmakingLobby>) => {
    for (const entry of lobbies) {
      details.set(entry.lobbyId, entry);
      await service.addLobbyToQueue(entry.lobbyId);
    }
    // Same as the join gateway: the joiner's broadcast includes everyone.
    await service.sendRegionStats();
  };

  // Mirrors the web badge: one size per queue entry, deduped across regions.
  const playCount = (
    message = [...redis.published]
      .reverse()
      .find(({ message }) => message.event === "matchmaking:region-stats")
      ?.message,
  ) => {
    const sizes = new Map<string, number>();
    for (const statsByKey of Object.values(message?.data ?? {}) as any[]) {
      for (const [key, entries] of Object.entries(statsByKey ?? {})) {
        for (const entry of entries as Array<{ index: number; size: number }>) {
          sizes.set(`${key}:${entry.index}`, entry.size);
        }
      }
    }
    return [...sizes.values()].reduce((total, size) => total + size, 0);
  };

  const confirmationIds = () =>
    [...redis.hashes.entries()]
      .filter(([, hash]) => hash.has("lobbyIds"))
      .map(([key]) => key.split(":").pop());

  const confirmationLobbyIds = (confirmationId: string): string[] =>
    JSON.parse(
      redis.hashes
        .get(getMatchmakingConformationCacheKey(confirmationId))
        .get("lobbyIds"),
    );

  beforeEach(() => {
    nextId = 0;
    redis = new FakeRedis();
    queue = new FakeQueue();
    details = new Map();

    const lobbyService = {
      getLobbyDetails: jest.fn(async (id: string) => details.get(id)),
      removeLobbyFromQueue: jest.fn(async (id: string) => {
        const entry = details.get(id);
        for (const region of entry?.regions ?? []) {
          await redis.zrem(
            getMatchmakingQueueCacheKey(entry.type, region, entry.variant),
            id,
          );
          await redis.zrem(
            getMatchmakingRankCacheKey(entry.type, region, entry.variant),
            id,
          );
        }
        return !!entry;
      }),
      removeLobbyDetails: jest.fn(async (id: string) => {
        details.delete(id);
      }),
      setMatchConformationIdForLobby: jest.fn(),
      removeConfirmationIdFromLobby: jest.fn(),
      sendQueueDetailsToLobby: jest.fn(),
    };

    captainPick = {
      startDraft: jest.fn().mockResolvedValue(undefined),
      hasDraft: jest.fn().mockResolvedValue(false),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };

    logger = new Logger("Test");
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});

    service = new MatchmakeService(
      logger,
      {
        query: jest.fn(async () => ({ server_regions: [{ value: REGION }] })),
        mutation: jest.fn(async () => ({})),
      } as any,
      { getConnection: () => redis } as any,
      {
        createMatchBasedOnType: jest.fn(async () => ({
          id: "match-1",
          lineup_1_id: "l1",
          lineup_2_id: "l2",
        })),
        updateMatchStatus: jest.fn(),
      } as any,
      lobbyService as any,
      { sendMatchFound: jest.fn().mockResolvedValue(undefined) } as any,
      captainPick as any,
      { getSettings: jest.fn(async () => ({ enabled: true })) } as any,
      queue as any,
    );

    // Requeue paths re-run the matchmaker on a timer; not needed here.
    jest.spyOn(global, "setTimeout").mockImplementation((() => 0) as any);
  });

  afterEach(() => {
    (global.setTimeout as unknown as jest.SpyInstance).mockRestore();
  });

  it("drops to 0 once the only 10 searching players get a match", async () => {
    await queueLobbies(Array.from({ length: 10 }, () => lobby()));
    expect(playCount()).toBe(10);

    await service.matchmake("Competitive", REGION);

    expect(confirmationIds()).toHaveLength(1);
    expect(playCount()).toBe(0);
  });

  it("keeps counting only the players still searching (15 -> 5)", async () => {
    await queueLobbies(Array.from({ length: 15 }, () => lobby()));
    expect(playCount()).toBe(15);

    await service.matchmake("Competitive", REGION);

    expect(playCount()).toBe(5);
  });

  it("counts only genuinely searching players across several matches", async () => {
    await queueLobbies(Array.from({ length: 25 }, () => lobby()));

    await service.matchmake("Competitive", REGION);
    await service.matchmake("Competitive", REGION);

    expect(confirmationIds()).toHaveLength(2);
    expect(playCount()).toBe(5);
  });

  it("applies to Wingman and Duel too", async () => {
    await queueLobbies([
      ...Array.from({ length: 5 }, () => lobby("Wingman")),
      ...Array.from({ length: 3 }, () => lobby("Duel")),
    ]);
    expect(playCount()).toBe(8);

    await service.matchmake("Wingman", REGION);
    expect(playCount()).toBe(4);

    await service.matchmake("Duel", REGION);
    expect(playCount()).toBe(2);
  });

  it("stays excluded after 10/10 accept creates the match", async () => {
    await queueLobbies(Array.from({ length: 12 }, () => lobby()));
    await service.matchmake("Competitive", REGION);
    const [confirmationId] = confirmationIds();

    for (const lobbyId of confirmationLobbyIds(confirmationId)) {
      await service.playerConfirmMatchmaking(confirmationId, lobbyId);
    }

    expect(
      redis.hashes
        .get(getMatchmakingConformationCacheKey(confirmationId))
        .get("matchId"),
    ).toBe("match-1");
    expect(playCount()).toBe(2);

    // Reconnect / F5 gets a fresh per-user snapshot with the same count.
    redis.published = [];
    await service.sendRegionStats({ steam_id: "viewer" } as any);
    expect(redis.published[0].channel).toBe("send-message-to-steam-id");
    expect(playCount()).toBe(2);
  });

  it("returns the accepted players to the count when the ready check fails", async () => {
    await queueLobbies(Array.from({ length: 15 }, () => lobby()));
    await service.matchmake("Competitive", REGION);
    const [confirmationId] = confirmationIds();
    expect(playCount()).toBe(5);

    // Nine accept, one doesn't: the nine go back to searching.
    const [declined, ...accepted] = confirmationLobbyIds(confirmationId);
    for (const lobbyId of accepted) {
      await service.playerConfirmMatchmaking(confirmationId, lobbyId);
    }
    await service.cancelMatchMaking(confirmationId);

    expect(details.has(declined)).toBe(false);
    expect(playCount()).toBe(14);
  });

  it("keeps counting players whose ready check could not be created", async () => {
    await queueLobbies(Array.from({ length: 10 }, () => lobby()));
    jest
      .spyOn(service as any, "setConfirmationDetails")
      .mockRejectedValueOnce(new Error("redis down"));

    await service.matchmake("Competitive", REGION);

    // Requeued, so the earlier broadcast of 10 is still the truth.
    expect(confirmationIds()).toHaveLength(0);
    expect(playCount()).toBe(10);
    await service.sendRegionStats();
    expect(playCount()).toBe(10);
  });

  it("never undoes the ready check if the broadcast itself fails", async () => {
    await queueLobbies(Array.from({ length: 10 }, () => lobby()));
    const send = jest
      .spyOn(service, "sendRegionStats")
      .mockRejectedValueOnce(new Error("hasura down"));

    await service.matchmake("Competitive", REGION);

    expect(send).toHaveBeenCalled();
    expect(confirmationIds()).toHaveLength(1);
    expect(
      await redis.zrange(
        getMatchmakingQueueCacheKey("Competitive", REGION),
        0,
        -1,
      ),
    ).toEqual([]);
  });

  describe("Captain Pick", () => {
    const captainPickLobbies = (count: number) =>
      Array.from({ length: count }, () => lobby("Competitive", "CaptainPick"));

    it("drops the ten players in the ready check (12 -> 2)", async () => {
      await queueLobbies(captainPickLobbies(12));
      expect(playCount()).toBe(12);

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(playCount()).toBe(2);
    });

    it("stays excluded once 10/10 starts the draft (PickingPlayers)", async () => {
      await queueLobbies(captainPickLobbies(10));
      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");
      const [confirmationId] = confirmationIds();

      for (const lobbyId of confirmationLobbyIds(confirmationId)) {
        await service.playerConfirmMatchmaking(confirmationId, lobbyId);
      }

      expect(captainPick.startDraft).toHaveBeenCalledWith(confirmationId);
      expect(playCount()).toBe(0);
      await service.sendRegionStats();
      expect(playCount()).toBe(0);
    });

    it("returns accepted players when the ready check fails", async () => {
      await queueLobbies(captainPickLobbies(10));
      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");
      const [confirmationId] = confirmationIds();

      const [, ...accepted] = confirmationLobbyIds(confirmationId);
      for (const lobbyId of accepted) {
        await service.playerConfirmMatchmaking(confirmationId, lobbyId);
      }
      await service.cancelMatchMaking(confirmationId);

      expect(playCount()).toBe(9);
    });
  });
});
