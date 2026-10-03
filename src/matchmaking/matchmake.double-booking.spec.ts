import { Logger } from "@nestjs/common";

// Same module mock as the main matchmake spec: the real service pulls in half
// the application.
jest.mock("../matches/match-assistant/match-assistant.service", () => ({
  MatchAssistantService: jest.fn(),
}));

import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobby } from "./types/MatchmakingLobby";
import { getMatchmakingPlayerClaimKey } from "./utilities/cacheKeys";

const REGION = "us-east";
const claimKey = getMatchmakingPlayerClaimKey;

// Everything is in memory: Redis is a Map, so claims behave like the real thing
// (SET NX, delete-if-equal, expiry is not modelled).
function harness(opts: { inMatch?: string[]; activeDrafts?: Record<string, string> } = {}) {
  const store = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const published: Array<{ steamId: string; event: string; data: any }> = [];

  const redis: any = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes("NX") && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    expire: jest.fn().mockResolvedValue(1),
    hset: jest.fn(async (key: string, a: any, b?: any) => {
      const hash = hashes.get(key) ?? {};
      if (typeof a === "object") Object.assign(hash, a);
      else hash[a] = String(b);
      hashes.set(key, hash);
      return 1;
    }),
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hgetall: jest.fn(async (key: string) => hashes.get(key) ?? {}),
    hdel: jest.fn(async (key: string, field: string) => {
      const hash = hashes.get(key);
      if (hash) delete hash[field];
      return 1;
    }),
    zrange: jest.fn().mockResolvedValue([]),
    zadd: jest.fn().mockResolvedValue(1),
    zrem: jest.fn().mockResolvedValue(1),
    publish: jest.fn(async (channel: string, payload: string) => {
      if (channel === "send-message-to-steam-id") published.push(JSON.parse(payload));
      return 1;
    }),
    // claimLobby's lock script succeeds; the claim-release script behaves
    // like delete-if-equal.
    eval: jest.fn(async (script: string, _n: number, ...rest: any[]) => {
      if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
        const [key, expected] = [rest[0], rest[1]];
        if (store.get(key) === expected) {
          store.delete(key);
          return 1;
        }
        return 0;
      }
      return 1;
    }),
  };

  const lobbies = new Map<string, MatchmakingLobby>();
  const lobbyService: any = {
    getLobbyDetails: jest.fn(async (id: string) => lobbies.get(id) ?? null),
    removeLobbyFromQueue: jest.fn().mockResolvedValue(true),
    removeLobbyDetails: jest.fn(),
    removeLobbyDetailsQuietly: jest.fn(async (id: string) => {
      lobbies.delete(id);
    }),
    setMatchConformationIdForLobby: jest.fn(),
    removeConfirmationIdFromLobby: jest.fn(),
    sendQueueDetailsToLobby: jest.fn(),
  };

  const hasura: any = {
    query: jest.fn(async () => ({
      players: (opts.inMatch ?? []).map((steam_id) => ({
        steam_id,
        is_in_another_match: true,
      })),
    })),
    mutation: jest.fn(),
  };

  const captainPick: any = {
    getActiveDraftId: jest.fn(async (id: string) => opts.activeDrafts?.[id] ?? null),
    hasDraft: jest.fn().mockResolvedValue(false),
    startDraft: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  };

  const service = new MatchmakeService(
    new Logger("test"),
    hasura,
    { getConnection: () => redis } as any,
    { createMatchBasedOnType: jest.fn(), updateMatchStatus: jest.fn() } as any,
    lobbyService,
    { sendMatchFound: jest.fn().mockResolvedValue(undefined) } as any,
    captainPick,
    { getSettings: jest.fn().mockResolvedValue({ enabled: true, pickSeconds: 30 }) } as any,
    { add: jest.fn(), remove: jest.fn() } as any,
  );
  jest.spyOn(service as any, "sendRegionStats").mockResolvedValue(undefined);
  jest.spyOn(service.logger, "warn").mockImplementation(() => undefined);

  const addLobby = (index: number, steamId = `steam-${index}`): MatchmakingLobby => {
    const lobby: MatchmakingLobby = {
      lobbyId: `lobby-${index}`,
      type: "Competitive",
      variant: "CaptainPick",
      regions: [REGION],
      players: [{ steam_id: steamId, rank: 1000 }],
      avgRank: 1000,
      joinedAt: new Date(1_700_000_000_000 + index),
      regionPositions: {},
    };
    lobbies.set(lobby.lobbyId, lobby);
    return lobby;
  };

  const queueCaptainPick = (ids: string[]) =>
    redis.zrange.mockResolvedValueOnce(ids);

  return { service, redis, store, hashes, published, lobbyService, hasura, captainPick, addLobby, queueCaptainPick };
}

describe("getBusySteamIds", () => {
  it("flags players already in a live match", async () => {
    const { service } = harness({ inMatch: ["a"] });
    expect([...(await service.getBusySteamIds(["a", "b"]))]).toEqual(["a"]);
  });

  it("flags players in someone else's Captain Pick draft, but not their own", async () => {
    const { service } = harness({ activeDrafts: { a: "other", b: "mine" } });
    expect([...(await service.getBusySteamIds(["a", "b"], "mine"))]).toEqual(["a"]);
  });

  it("flags players held by a different ready check, but not this one", async () => {
    const { service, store } = harness();
    store.set(claimKey("a"), "other");
    store.set(claimKey("b"), "mine");
    expect([...(await service.getBusySteamIds(["a", "b"], "mine"))]).toEqual(["a"]);
  });

  it("never blocks matchmaking when the lookups fail", async () => {
    const { service, hasura, captainPick, redis } = harness();
    hasura.query.mockRejectedValue(new Error("hasura down"));
    captainPick.getActiveDraftId.mockRejectedValue(new Error("redis down"));
    redis.get.mockRejectedValue(new Error("redis down"));
    expect((await service.getBusySteamIds(["a"])).size).toBe(0);
  });
});

describe("Captain Pick queue pass", () => {
  const formDraft = async (h: ReturnType<typeof harness>) => {
    await h.service.matchmakeCaptainPick(REGION);
  };

  it("never pulls a player who is already in a match into a ready check", async () => {
    const h = harness({ inMatch: ["steam-3"] });
    for (let i = 1; i <= 10; i++) h.addLobby(i);
    h.queueCaptainPick(Array.from({ length: 10 }, (_, i) => `lobby-${i + 1}`));

    await formDraft(h);

    // Only nine eligible players remain, so no ready check is created.
    expect(h.redis.hset).not.toHaveBeenCalledWith(
      expect.stringContaining("conf"),
      expect.objectContaining({ variant: "CaptainPick" }),
    );
    expect(h.store.size).toBe(0);
    expect(h.lobbyService.removeLobbyDetailsQuietly).toHaveBeenCalledWith("lobby-3");
    // The busy player is not sent an empty details event that would blank
    // the screen of the match they are in.
    expect(h.published.filter((m) => m.steamId === "steam-3")).toEqual([]);
  });

  it("keeps only the first queue entry when one player is queued twice", async () => {
    const h = harness();
    for (let i = 1; i <= 9; i++) h.addLobby(i);
    // The same person again, as a second lobby that joined later.
    h.addLobby(10, "steam-1");
    h.queueCaptainPick(Array.from({ length: 10 }, (_, i) => `lobby-${i + 1}`));

    await formDraft(h);

    expect(h.lobbyService.removeLobbyDetailsQuietly).toHaveBeenCalledWith("lobby-10");
    expect(h.lobbyService.removeLobbyDetailsQuietly).not.toHaveBeenCalledWith("lobby-1");
    // Nine distinct players are not enough for a draft.
    expect(h.store.size).toBe(0);
  });

  it("claims all ten players for the ready check it creates", async () => {
    const h = harness();
    for (let i = 1; i <= 10; i++) h.addLobby(i);
    h.queueCaptainPick(Array.from({ length: 10 }, (_, i) => `lobby-${i + 1}`));

    await formDraft(h);

    const claims = [...h.store.entries()].filter(([key]) => key.includes(":confirmation:player:"));
    expect(claims).toHaveLength(10);
    expect(new Set(claims.map(([, id]) => id)).size).toBe(1);
  });

  it("refuses a second ready check for players who already hold one", async () => {
    const h = harness();
    for (let i = 1; i <= 10; i++) h.addLobby(i);
    // steam-4 is already in another ready check.
    h.store.set(claimKey("steam-4"), "other-confirmation");
    h.queueCaptainPick(Array.from({ length: 10 }, (_, i) => `lobby-${i + 1}`));

    await formDraft(h);

    expect(h.lobbyService.removeLobbyDetailsQuietly).toHaveBeenCalledWith("lobby-4");
    // The other nine did not get a ready check either (only 9 left).
    const ours = [...h.store.entries()].filter(([, id]) => id !== "other-confirmation");
    expect(ours).toEqual([]);
  });
});

describe("accepting a ready check", () => {
  const confirmation = (h: ReturnType<typeof harness>, id: string, steamIds: string[]) => {
    h.hashes.set(`matchmaking:v1:confirmation:${id}`, {});
    jest
      .spyOn(h.service, "getMatchConfirmationDetails")
      .mockImplementation(async () => ({
        type: "Competitive",
        variant: "CaptainPick",
        region: REGION,
        lobbyIds: steamIds.map((_, i) => `lobby-${i + 1}`),
        team1: [],
        team2: [],
        participants: steamIds.map((steam_id, i) => ({
          steam_id,
          lobbyId: `lobby-${i + 1}`,
          joinedAt: new Date().toISOString(),
        })),
        matchId: undefined as any,
        expiresAt: new Date().toISOString(),
        confirmed: [...(confirmedSet.get(id) ?? [])],
      }));
  };
  const confirmedSet = new Map<string, Set<string>>();

  beforeEach(() => confirmedSet.clear());

  it("cancels the ready check instead of confirming a player who is in another match", async () => {
    const h = harness({ inMatch: ["steam-2"] });
    const ids = Array.from({ length: 10 }, (_, i) => `steam-${i + 1}`);
    ids.forEach((_, i) => h.addLobby(i + 1));
    confirmation(h, "c1", ids);
    const cancel = jest.spyOn(h.service, "cancelMatchMaking").mockResolvedValue(undefined);

    await h.service.playerConfirmMatchmaking("c1", "steam-2");

    expect(cancel).toHaveBeenCalledWith("c1");
    expect(h.published).toContainEqual(
      expect.objectContaining({ steamId: "steam-2", event: "matchmaking:error" }),
    );
    expect(h.captainPick.startDraft).not.toHaveBeenCalled();
  });

  it("confirms a free player normally", async () => {
    const h = harness();
    const ids = Array.from({ length: 10 }, (_, i) => `steam-${i + 1}`);
    ids.forEach((_, i) => h.addLobby(i + 1));
    confirmation(h, "c2", ids);
    const cancel = jest.spyOn(h.service, "cancelMatchMaking").mockResolvedValue(undefined);

    await h.service.playerConfirmMatchmaking("c2", "steam-1");

    expect(cancel).not.toHaveBeenCalled();
    expect(h.redis.hset).toHaveBeenCalledWith(
      expect.stringContaining(":confirmed"),
      "steam-1",
      1,
    );
  });

  it("does not start a draft when someone turns out to be in a match at the last moment", async () => {
    const h = harness({ inMatch: ["steam-7"] });
    const ids = Array.from({ length: 10 }, (_, i) => `steam-${i + 1}`);
    ids.forEach((_, i) => h.addLobby(i + 1));
    // All ten have accepted, including steam-7 who has since joined a match.
    confirmedSet.set("c3", new Set(ids));
    confirmation(h, "c3", ids);
    // The accepting player (steam-1) is free; steam-7 is the busy one.
    const cancel = jest.spyOn(h.service, "cancelMatchMaking").mockResolvedValue(undefined);

    await h.service.playerConfirmMatchmaking("c3", "steam-1");

    expect(h.captainPick.startDraft).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("c3");
    expect(h.published).toContainEqual(
      expect.objectContaining({ steamId: "steam-7", event: "matchmaking:error" }),
    );
  });

  it("starts the draft when all ten are free", async () => {
    const h = harness();
    const ids = Array.from({ length: 10 }, (_, i) => `steam-${i + 1}`);
    ids.forEach((_, i) => h.addLobby(i + 1));
    confirmedSet.set("c4", new Set(ids));
    confirmation(h, "c4", ids);

    await h.service.playerConfirmMatchmaking("c4", "steam-1");

    expect(h.captainPick.startDraft).toHaveBeenCalledWith("c4");
  });

  it("does not treat a late accept of an already started draft as a double booking", async () => {
    const h = harness({ inMatch: ["steam-1"] });
    const ids = Array.from({ length: 10 }, (_, i) => `steam-${i + 1}`);
    ids.forEach((_, i) => h.addLobby(i + 1));
    confirmedSet.set("c5", new Set(ids));
    confirmation(h, "c5", ids);
    h.captainPick.hasDraft.mockResolvedValue(true);
    const cancel = jest.spyOn(h.service, "cancelMatchMaking").mockResolvedValue(undefined);

    await h.service.playerConfirmMatchmaking("c5", "steam-1");

    expect(cancel).not.toHaveBeenCalled();
    expect(h.published.filter((m) => m.event === "matchmaking:error")).toEqual([]);
  });
});

describe("ending a ready check", () => {
  it("frees its players to join another one", async () => {
    const h = harness();
    jest.spyOn(h.service, "getMatchConfirmationDetails").mockResolvedValue({
      type: "Competitive",
      variant: "CaptainPick",
      region: REGION,
      lobbyIds: [],
      team1: [],
      team2: [],
      participants: [
        { steam_id: "a", lobbyId: "l1", joinedAt: "" },
        { steam_id: "b", lobbyId: "l2", joinedAt: "" },
      ],
      matchId: undefined as any,
      expiresAt: "",
      confirmed: [],
    });
    h.store.set(claimKey("a"), "c1");
    h.store.set(claimKey("b"), "other");

    await h.service.removeConfirmationDetails("c1");

    expect(h.store.has(claimKey("a"))).toBe(false);
    // A claim that belongs to a different ready check is left alone.
    expect(h.store.get(claimKey("b"))).toBe("other");
  });
});
