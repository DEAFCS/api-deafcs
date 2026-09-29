import { Logger } from "@nestjs/common";

jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { FakeQueue, FakeRedis } from "../../test/mocks/fake-redis";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
} from "./utilities/cacheKeys";
import {
  CAPTAIN_PICK_DISABLED_ERROR,
  CAPTAIN_PICK_SOLO_ONLY_ERROR,
} from "./captain-pick/captain-pick-queue-rules";

const REGION = "Europe";
const T0 = new Date("2026-09-29T18:00:00.000Z").getTime();
const steam = (n: number) => `765611980000001${String(n).padStart(2, "0")}`;

const cpLobby = (n: number, players = 1): MatchmakingLobby => ({
  type: "Competitive",
  variant: "CaptainPick",
  regions: [REGION],
  // Queue order: lower n joined earlier.
  joinedAt: new Date(T0 + n * 1000),
  lobbyId: players === 1 ? steam(n) : `party-${n}`,
  players: Array.from({ length: players }, (_, i) => ({
    steam_id: i === 0 ? steam(n) : `${steam(n)}-${i}`,
    rank: 5000,
  })),
  regionPositions: {},
  avgRank: 5000,
});

describe("MatchmakeService Captain Pick", () => {
  let redis: FakeRedis;
  let queue: FakeQueue;
  let service: MatchmakeService;
  let details: Map<string, MatchmakingLobby>;
  let lobbyService: Record<string, jest.Mock>;
  let captainPick: Record<string, jest.Mock>;
  let matchAssistant: Record<string, jest.Mock>;
  let enabled: boolean;

  const queueLobby = async (lobby: MatchmakingLobby) => {
    details.set(lobby.lobbyId, lobby);
    await service.addLobbyToQueue(lobby.lobbyId);
  };

  const confirmationIds = () =>
    [...redis.hashes.entries()]
      .filter(([, hash]) => hash.get("variant") === "CaptainPick")
      .map(([key]) => key.replace("matchmaking:v20:", ""));

  beforeEach(() => {
    redis = new FakeRedis();
    queue = new FakeQueue();
    details = new Map();
    enabled = true;

    lobbyService = {
      getLobbyDetails: jest.fn(async (id: string) => details.get(id)),
      removeLobbyFromQueue: jest.fn(async (id: string) => {
        const lobby = details.get(id);
        for (const region of lobby?.regions ?? []) {
          await redis.zrem(
            getMatchmakingQueueCacheKey(lobby.type, region, lobby.variant),
            id,
          );
          await redis.zrem(
            getMatchmakingRankCacheKey(lobby.type, region, lobby.variant),
            id,
          );
        }
        return !!lobby;
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

    matchAssistant = {
      createMatchBasedOnType: jest.fn(async () => ({
        id: "match-1",
        lineup_1_id: "l1",
        lineup_2_id: "l2",
      })),
      updateMatchStatus: jest.fn(),
    };

    const logger = new Logger("Test");
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "error").mockImplementation(() => {});

    service = new MatchmakeService(
      logger,
      {
        query: jest.fn(async () => ({ server_regions: [{ value: REGION }] })),
        mutation: jest.fn(async () => ({})),
      } as any,
      { getConnection: () => redis } as any,
      matchAssistant as any,
      lobbyService as any,
      { sendMatchFound: jest.fn().mockResolvedValue(undefined) } as any,
      captainPick as any,
      {
        getSettings: jest.fn(async () => ({ enabled, pickSeconds: 30 })),
      } as any,
      queue as any,
    );
  });

  describe("forming a ready check", () => {
    it("takes the ten longest-waiting solo players, with no team split", async () => {
      // Queued out of order on purpose; 12 players, only 10 fit.
      for (const n of [12, 3, 7, 1, 10, 5, 2, 11, 9, 4, 8, 6]) {
        await queueLobby(cpLobby(n));
      }
      const split = jest.spyOn(service as any, "splitIntoBalancedTeams");
      const standardConfirmation = jest.spyOn(
        service as any,
        "createMatchConfirmation",
      );

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      const [confirmationId] = confirmationIds();
      const hash = redis.hashes.get(
        getMatchmakingConformationCacheKey(confirmationId),
      );
      expect(confirmationIds()).toHaveLength(1);
      expect(hash.get("type")).toBe("Competitive");
      expect(hash.get("region")).toBe(REGION);
      expect(hash.get("team1")).toBe("[]");
      expect(hash.get("team2")).toBe("[]");
      expect(JSON.parse(hash.get("participants"))).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
          steam_id: steam(n),
          lobbyId: steam(n),
          joinedAt: new Date(T0 + n * 1000).toISOString(),
        })),
      );

      expect(split).not.toHaveBeenCalled();
      expect(standardConfirmation).not.toHaveBeenCalled();

      // The two latest joiners are still waiting in the Captain Pick queue.
      expect(
        await redis.zrange(
          getMatchmakingQueueCacheKey("Competitive", REGION, "CaptainPick"),
          0,
          -1,
        ),
      ).toEqual(expect.arrayContaining([steam(11), steam(12)]));
      expect(
        await redis.zrange(
          getMatchmakingQueueCacheKey("Competitive", REGION, "CaptainPick"),
          0,
          -1,
        ),
      ).toHaveLength(2);

      // Same 30 second ready check as Standard.
      expect(queue.byName("CancelMatchMaking")).toHaveLength(1);
      expect(queue.byName("CancelMatchMaking")[0].opts.delay).toBe(30000);
    });

    it("never touches the Standard 5v5 queue", async () => {
      for (let n = 1; n <= 10; n++) {
        await queueLobby(cpLobby(n));
      }
      const standard: MatchmakingLobby = { ...cpLobby(50), variant: undefined };
      await queueLobby(standard);

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(
        await redis.zrange(
          getMatchmakingQueueCacheKey("Competitive", REGION),
          0,
          -1,
        ),
      ).toEqual([standard.lobbyId]);
      expect(
        JSON.parse(
          redis.hashes
            .get(getMatchmakingConformationCacheKey(confirmationIds()[0]))
            .get("participants"),
        ).map((p: any) => p.steam_id),
      ).not.toContain(standard.players[0].steam_id);
    });

    it("waits with fewer than ten", async () => {
      for (let n = 1; n <= 9; n++) {
        await queueLobby(cpLobby(n));
      }

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(confirmationIds()).toHaveLength(0);
      expect(
        await redis.zrange(
          getMatchmakingQueueCacheKey("Competitive", REGION, "CaptainPick"),
          0,
          -1,
        ),
      ).toHaveLength(9);
    });

    it("uses its own region lock and releases it", async () => {
      await redis.set("matchmaking:lock:Europe", 1);
      for (let n = 1; n <= 10; n++) {
        await queueLobby(cpLobby(n));
      }

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(confirmationIds()).toHaveLength(1);
      expect(
        await redis.get("matchmaking:lock:Europe:captain-pick"),
      ).toBeNull();
      // A held Standard lock is untouched.
      expect(await redis.get("matchmaking:lock:Europe")).toBe("1");
    });

    it("does nothing while another Captain Pick pass holds the lock", async () => {
      await redis.set("matchmaking:lock:Europe:captain-pick", 1);
      for (let n = 1; n <= 10; n++) {
        await queueLobby(cpLobby(n));
      }

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(confirmationIds()).toHaveLength(0);
    });

    it("stops forming drafts when the feature is off and tells the queue why", async () => {
      enabled = false;
      for (let n = 1; n <= 10; n++) {
        await queueLobby(cpLobby(n));
      }

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(confirmationIds()).toHaveLength(0);
      expect(details.size).toBe(0);
      expect(redis.messagesTo(steam(1), "matchmaking:error")[0].data).toEqual({
        message: CAPTAIN_PICK_DISABLED_ERROR,
      });
    });

    it("drops a party that somehow got into the queue", async () => {
      for (let n = 1; n <= 9; n++) {
        await queueLobby(cpLobby(n));
      }
      await queueLobby(cpLobby(10, 2));

      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");

      expect(confirmationIds()).toHaveLength(0);
      expect(details.has("party-10")).toBe(false);
      expect(redis.messagesTo(steam(10), "matchmaking:error")[0].data).toEqual({
        message: CAPTAIN_PICK_SOLO_ONLY_ERROR,
      });
    });
  });

  describe("ready check", () => {
    let confirmationId: string;

    beforeEach(async () => {
      for (let n = 1; n <= 10; n++) {
        await queueLobby(cpLobby(n));
      }
      await service.matchmakeQueue("Competitive", REGION, "CaptainPick");
      [confirmationId] = confirmationIds();
    });

    const confirm = (n: number) =>
      service.playerConfirmMatchmaking(confirmationId, steam(n));

    it("does not start the draft at 9/10", async () => {
      for (let n = 1; n <= 9; n++) {
        await confirm(n);
      }

      expect(captainPick.startDraft).not.toHaveBeenCalled();
      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
    });

    it("starts the draft exactly once at 10/10 and ends the ready check", async () => {
      for (let n = 1; n <= 10; n++) {
        await confirm(n);
      }

      expect(captainPick.startDraft).toHaveBeenCalledTimes(1);
      expect(captainPick.startDraft).toHaveBeenCalledWith(confirmationId);
      expect(queue.byName("CancelMatchMaking")).toHaveLength(0);
      // No automatic match: teams come from the draft.
      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
    });

    it("starts one draft when the last confirmations race", async () => {
      for (let n = 1; n <= 8; n++) {
        await confirm(n);
      }

      await Promise.all([confirm(9), confirm(10), confirm(10)]);

      expect(captainPick.startDraft).toHaveBeenCalledTimes(1);
    });

    it("keeps the ready-check job if the draft could not start, so it can retry", async () => {
      captainPick.startDraft.mockRejectedValueOnce(new Error("hasura down"));

      for (let n = 1; n <= 9; n++) {
        await confirm(n);
      }
      await expect(confirm(10)).rejects.toThrow("hasura down");

      expect(queue.byName("CancelMatchMaking")).toHaveLength(1);
    });

    describe("a failed ready check (before 10/10)", () => {
      beforeEach(async () => {
        for (let n = 1; n <= 9; n++) {
          await confirm(n);
        }
        jest.spyOn(global, "setTimeout").mockImplementation(((
          fn: () => void,
        ) => {
          fn();
          return 0 as any;
        }) as any);
      });

      afterEach(() => {
        (global.setTimeout as unknown as jest.SpyInstance).mockRestore();
      });

      it("drops the player who didn't accept and requeues the rest into Captain Pick", async () => {
        const matchmakeQueue = jest
          .spyOn(service, "matchmakeQueue")
          .mockResolvedValue(undefined);

        await service.cancelMatchMaking(confirmationId);

        expect(details.has(steam(10))).toBe(false);
        const requeued = await redis.zrange(
          getMatchmakingQueueCacheKey("Competitive", REGION, "CaptainPick"),
          0,
          -1,
        );
        expect(requeued.sort()).toEqual(
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map(steam).sort(),
        );
        expect(
          await redis.zrange(
            getMatchmakingQueueCacheKey("Competitive", REGION),
            0,
            -1,
          ),
        ).toEqual([]);
        // Queue time survives the requeue.
        expect(details.get(steam(1)).joinedAt).toEqual(new Date(T0 + 1000));
        expect(matchmakeQueue).toHaveBeenCalledWith(
          "Competitive",
          REGION,
          "CaptainPick",
        );
        expect(captainPick.startDraft).not.toHaveBeenCalled();
      });
    });

    describe("after 10/10 (committed)", () => {
      beforeEach(async () => {
        for (let n = 1; n <= 10; n++) {
          await confirm(n);
        }
      });

      it("a stale ready-check job cannot cancel a running draft", async () => {
        captainPick.hasDraft.mockResolvedValue(true);

        await service.cancelMatchMaking(confirmationId);

        expect(lobbyService.removeLobbyDetails).not.toHaveBeenCalled();
        expect(lobbyService.removeLobbyFromQueue).not.toHaveBeenCalled();
        expect(captainPick.cleanup).not.toHaveBeenCalled();
        expect(
          redis.hashes.has(getMatchmakingConformationCacheKey(confirmationId)),
        ).toBe(true);
      });

      it("a stale ready-check job starts a draft that never got started", async () => {
        captainPick.startDraft.mockClear();

        await service.cancelMatchMaking(confirmationId);

        expect(captainPick.startDraft).toHaveBeenCalledWith(confirmationId);
        expect(lobbyService.removeLobbyDetails).not.toHaveBeenCalled();
      });

      it("the match ending cleans the draft up with the confirmation", async () => {
        await service.cancelMatchMaking(confirmationId, true);

        expect(captainPick.cleanup).toHaveBeenCalledWith(confirmationId);
        expect(
          redis.hashes.has(getMatchmakingConformationCacheKey(confirmationId)),
        ).toBe(false);
      });
    });
  });

  describe("Standard 5v5 is unchanged", () => {
    const writeStandardConfirmation = async (id: string) => {
      await redis.hset(getMatchmakingConformationCacheKey(id), {
        type: "Competitive",
        region: REGION,
        expiresAt: new Date(T0).toISOString(),
        lobbyIds: JSON.stringify(["a", "b"]),
        team1: JSON.stringify([{ steam_id: "1", rank: 5000 }]),
        team2: JSON.stringify([{ steam_id: "2", rank: 5000 }]),
      });
    };

    it("creates the match with exactly the same options as before", async () => {
      await writeStandardConfirmation("std");
      await service.playerConfirmMatchmaking("std", "1");
      await service.playerConfirmMatchmaking("std", "2");

      expect(captainPick.startDraft).not.toHaveBeenCalled();
      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledWith(
        "Competitive",
        "Competitive",
        {
          mr: 12,
          best_of: 1,
          knife: true,
          overtime: true,
          timeout_setting: "CoachAndPlayers",
          region: REGION,
        },
      );
      expect(matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
        "match-1",
        "Live",
      );
    });

    it("keeps Wingman and Duel options too", async () => {
      await redis.hset(getMatchmakingConformationCacheKey("w"), {
        type: "Wingman",
        region: REGION,
        lobbyIds: "[]",
        team1: JSON.stringify([{ steam_id: "1", rank: 1 }]),
        team2: "[]",
      });
      await service.playerConfirmMatchmaking("w", "1");

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledWith(
        "Wingman",
        "Wingman",
        expect.objectContaining({ mr: 8, best_of: 1 }),
      );
    });

    it("refuses to auto-create a Captain Pick match", async () => {
      await redis.hset(getMatchmakingConformationCacheKey("cp"), {
        type: "Competitive",
        variant: "CaptainPick",
        region: REGION,
      });

      await expect((service as any).createMatch("cp")).rejects.toThrow(
        /refusing to auto-create/,
      );
      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
    });

    it("still runs the Standard matchmaker for Standard", async () => {
      const matchmake = jest
        .spyOn(service, "matchmake")
        .mockResolvedValue(undefined);
      const captain = jest.spyOn(service, "matchmakeCaptainPick");

      await service.matchmakeQueue("Competitive", REGION);
      await service.matchmakeQueue("Competitive", REGION, "Standard");

      expect(matchmake).toHaveBeenCalledTimes(2);
      expect(captain).not.toHaveBeenCalled();
    });
  });
});
