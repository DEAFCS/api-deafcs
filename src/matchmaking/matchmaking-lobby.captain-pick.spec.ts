import { Logger } from "@nestjs/common";

jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { CaptainPickService } from "./captain-pick/captain-pick.service";
import { MarkPlayerOffline } from "./jobs/MarkPlayerOffline";
import { FakeQueue, FakeRedis } from "../../test/mocks/fake-redis";
import {
  getCaptainPickPlayerCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
} from "./utilities/cacheKeys";

const CONFIRMATION_ID = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-09-29T18:00:00.000Z").getTime();
const steam = (n: number) => `765611980000002${String(n).padStart(2, "0")}`;

/**
 * A committed Captain Pick draft must not depend on lobby records: offline
 * cleanup (MarkPlayerOffline) and joining a party (lobby_players event) both
 * remove those, and neither may cancel, hide or break the draft.
 */
describe("Captain Pick and lobby cleanup", () => {
  let redis: FakeRedis;
  let captainPick: CaptainPickService;
  let lobbyService: MatchmakingLobbyService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let matchmaking: Record<string, jest.Mock>;

  beforeEach(async () => {
    redis = new FakeRedis();
    const redisManager = { getConnection: () => redis } as any;

    hasura = {
      query: jest.fn(async (query: any) => {
        if (query.players) {
          return {
            players: query.players.__args.where.steam_id._in.map(
              (id: string, i: number) => ({
                steam_id: id,
                name: `Player ${i}`,
                avatar_url: null as string | null,
                elo: { competitive: 10000 - i * 100 },
              }),
            ),
          };
        }
        if (query.players_by_pk) {
          return {
            players_by_pk: {
              current_lobby_id: null as string | null,
              name: "Player",
              steam_id: query.players_by_pk.__args.steam_id,
              is_banned: false,
              matchmaking_cooldown: null as string | null,
            },
          };
        }
        throw new Error(`unexpected query ${Object.keys(query)}`);
      }),
      mutation: jest.fn(async () => ({})),
    };

    const logger = new Logger("Test");
    jest.spyOn(logger, "log").mockImplementation(() => {});

    captainPick = new CaptainPickService(
      logger,
      hasura as any,
      redisManager,
      {} as any,
      { getSettings: async () => ({ enabled: true, pickSeconds: 30 }) } as any,
      new FakeQueue() as any,
    );

    matchmaking = {
      sendRegionStats: jest.fn().mockResolvedValue(undefined),
      getMatchConfirmationDetails: jest.fn(),
      getConfirmationPlayerCount: jest.fn(),
      removeConfirmationDetails: jest.fn(),
    };

    lobbyService = new MatchmakingLobbyService(
      logger,
      hasura as any,
      redisManager,
      matchmaking as any,
      captainPick,
    );

    const participants = Array.from({ length: 10 }, (_, i) => ({
      steam_id: steam(i + 1),
      lobbyId: steam(i + 1),
      joinedAt: new Date(T0 + i * 1000).toISOString(),
    }));

    await redis.hset(getMatchmakingConformationCacheKey(CONFIRMATION_ID), {
      type: "Competitive",
      variant: "CaptainPick",
      region: "Europe",
      expiresAt: new Date(T0).toISOString(),
      lobbyIds: JSON.stringify(participants.map((p) => p.lobbyId)),
      participants: JSON.stringify(participants),
      team1: "[]",
      team2: "[]",
    });

    for (const participant of participants) {
      await redis.hset(
        getMatchmakingLobbyDetailsCacheKey(participant.lobbyId),
        {
          details: JSON.stringify({
            type: "Competitive",
            variant: "CaptainPick",
            regions: ["Europe"],
            joinedAt: participant.joinedAt,
            lobbyId: participant.lobbyId,
            players: [{ steam_id: participant.steam_id, rank: 5000 }],
            avgRank: 5000,
          }),
          confirmationId: CONFIRMATION_ID,
        },
      );
    }

    await captainPick.startDraft(CONFIRMATION_ID);
    redis.published = [];
  });

  it("survives the player going offline (MarkPlayerOffline)", async () => {
    const before = await captainPick.getState(CONFIRMATION_ID);

    await new MarkPlayerOffline(
      hasura as any,
      lobbyService,
      matchmaking as any,
    ).process({ data: { steamId: steam(1) } } as any);

    expect(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey(steam(1)), "details"),
    ).toBeNull();
    expect(await captainPick.getState(CONFIRMATION_ID)).toEqual(before);
    expect(await redis.get(getCaptainPickPlayerCacheKey(steam(1)))).toBe(
      CONFIRMATION_ID,
    );
    // No "you left the queue" blank update for a committed player.
    expect(redis.messagesTo(steam(1), "matchmaking:details")).toEqual([]);
  });

  it("survives the player joining a party (lobby records removed)", async () => {
    const before = await captainPick.getState(CONFIRMATION_ID);

    await lobbyService.removeLobbyFromQueue(steam(2));
    await lobbyService.removeLobbyDetails(steam(2));

    expect(await captainPick.getState(CONFIRMATION_ID)).toEqual(before);
    expect(redis.messagesTo(steam(2), "matchmaking:details")).toEqual([]);
  });

  it("restores the draft on reconnect/F5 without any lobby record", async () => {
    await lobbyService.removeLobbyDetails(steam(3));
    hasura.query.mockClear();

    await lobbyService.sendQueueDetailsToPlayer(steam(3));

    const [message] = redis.messagesTo(steam(3), "matchmaking:details");
    expect(message.data.confirmation.confirmationId).toBe(CONFIRMATION_ID);
    expect(message.data.confirmation.captainPick.phase).toBe("Drafting");
    expect(message.data.confirmation.captainPick.deadline).toBe(
      (await captainPick.getState(CONFIRMATION_ID))?.timer?.deadline,
    );
    // Found through the reverse key, not the player's lobby.
    expect(hasura.query).not.toHaveBeenCalled();
    // Only the reconnecting player is sent the state.
    expect(redis.messagesTo(steam(4), "matchmaking:details")).toEqual([]);
  });

  it("delivers the draft through the lobby path too", async () => {
    matchmaking.getMatchConfirmationDetails.mockResolvedValue({
      type: "Competitive",
      variant: "CaptainPick",
      region: "Europe",
      team1: [],
      team2: [],
      participants: [{ steam_id: steam(5), lobbyId: steam(5) }],
      lobbyIds: [steam(5)],
      confirmed: [],
    });

    await lobbyService.sendQueueDetailsToLobby(steam(5));

    const [message] = redis.messagesTo(steam(5), "matchmaking:details");
    expect(message.data.confirmation.captainPick.draftId).toBe(CONFIRMATION_ID);
  });

  it("stores the variant only on Captain Pick lobbies", async () => {
    const player = {
      steam_id: steam(9),
      is_banned: false,
      matchmaking_cooldown: false,
    };

    await lobbyService.setLobbyDetails(["Europe"], "Competitive", {
      id: "std",
      players: [player],
    });
    await lobbyService.setLobbyDetails(
      ["Europe"],
      "Competitive",
      { id: "cp", players: [player] },
      "CaptainPick",
    );

    const standard = JSON.parse(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey("std"), "details"),
    );
    const cp = JSON.parse(
      await redis.hget(getMatchmakingLobbyDetailsCacheKey("cp"), "details"),
    );
    expect(Object.keys(standard)).toEqual([
      "type",
      "regions",
      "joinedAt",
      "lobbyId",
      "players",
      "avgRank",
      "regionPositions",
    ]);
    expect(cp.variant).toBe("CaptainPick");
  });
});
