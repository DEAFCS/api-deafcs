import { MatchmakingGateway } from "./matchmaking.gateway";

// Covers the Terms-acceptance enforcement added to matchmaking:join-queue
// (party-wide -- an accepted leader must not be able to bring an unaccepted
// party member into the queue with them) and matchmaking:confirm
// (single-user). The rest of joinQueue's setting/region/latency plumbing is
// stubbed to the minimum needed to reach that check, not re-tested here.
describe("MatchmakingGateway Terms enforcement", () => {
  let gateway: any;
  let hasura: { query: jest.Mock };
  let matchmakingLobbyService: {
    getPlayerLobby: jest.Mock;
    verifyLobby: jest.Mock;
    setLobbyDetails: jest.Mock;
  };
  let matchmakeService: {
    addLobbyToQueue: jest.Mock;
    sendRegionStats: jest.Mock;
    matchmake: jest.Mock;
    playerConfirmMatchmaking: jest.Mock;
  };
  let cache: { lock: jest.Mock };
  let terms: { hasAcceptedCurrentTerms: jest.Mock };
  let redis: { publish: jest.Mock; hgetall: jest.Mock };
  let logger: { error: jest.Mock };

  const leader = { steam_id: "1", captain: true };
  const member = { steam_id: "2", captain: false };

  const lobby = { id: "lobby-1", players: [leader, member] };

  beforeEach(() => {
    hasura = {
      query: jest.fn((query: any) => {
        if (query.settings) return Promise.resolve({ settings: [] });
        if (query.server_regions)
          return Promise.resolve({
            server_regions: [{ value: "TestA", is_lan: false, status: "Enabled" }],
          });
        if (query.game_server_nodes_aggregate)
          return Promise.resolve({
            game_server_nodes_aggregate: { aggregate: { count: 0 } },
          });
        return Promise.resolve({});
      }),
    };
    matchmakingLobbyService = {
      getPlayerLobby: jest.fn().mockResolvedValue(lobby),
      verifyLobby: jest.fn().mockResolvedValue(undefined),
      setLobbyDetails: jest.fn().mockResolvedValue(undefined),
    };
    matchmakeService = {
      addLobbyToQueue: jest.fn().mockResolvedValue(undefined),
      sendRegionStats: jest.fn().mockResolvedValue(undefined),
      matchmake: jest.fn().mockResolvedValue(undefined),
      playerConfirmMatchmaking: jest.fn().mockResolvedValue(undefined),
    };
    cache = { lock: jest.fn((key: string, fn: () => unknown) => fn()) };
    terms = { hasAcceptedCurrentTerms: jest.fn() };
    redis = { publish: jest.fn().mockResolvedValue(undefined), hgetall: jest.fn().mockResolvedValue({}) };
    logger = { error: jest.fn() };

    gateway = Object.create(MatchmakingGateway.prototype);
    gateway.logger = logger;
    gateway.hasura = hasura;
    gateway.matchmakingLobbyService = matchmakingLobbyService;
    gateway.matchmakeService = matchmakeService;
    gateway.cache = cache;
    gateway.terms = terms;
    gateway.redis = redis;
  });

  const client = (steamId: string) => ({
    user: { steam_id: steamId, role: "user" },
    sessionId: "session-1",
  });

  describe("matchmaking:join-queue", () => {
    it("denies the whole party when the leader has accepted but a party member has not", async () => {
      terms.hasAcceptedCurrentTerms.mockImplementation((steamId: string) =>
        Promise.resolve(steamId === leader.steam_id),
      );

      await gateway.joinQueue(
        { type: "Competitive", regions: ["TestA"] },
        client(leader.steam_id),
      );

      expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
      // Broadcast to every party member, not just the caller.
      const publishedTo = redis.publish.mock.calls.map(
        ([, payload]: [string, string]) => JSON.parse(payload).steamId,
      );
      expect(publishedTo.sort()).toEqual([leader.steam_id, member.steam_id].sort());
      for (const call of redis.publish.mock.calls) {
        expect(JSON.parse(call[1]).event).toBe("matchmaking:error");
      }
    });

    it("allows the party through when every member has accepted", async () => {
      terms.hasAcceptedCurrentTerms.mockResolvedValue(true);

      await gateway.joinQueue(
        { type: "Competitive", regions: ["TestA"] },
        client(leader.steam_id),
      );

      expect(terms.hasAcceptedCurrentTerms).toHaveBeenCalledWith(leader.steam_id);
      expect(terms.hasAcceptedCurrentTerms).toHaveBeenCalledWith(member.steam_id);
      expect(matchmakeService.addLobbyToQueue).toHaveBeenCalledWith(lobby.id);
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("denies a solo (unaccepted) player the same way", async () => {
      const solo = { id: "lobby-2", players: [{ steam_id: "3", captain: true }] };
      matchmakingLobbyService.getPlayerLobby.mockResolvedValue(solo);
      terms.hasAcceptedCurrentTerms.mockResolvedValue(false);

      await gateway.joinQueue(
        { type: "Competitive", regions: ["TestA"] },
        client("3"),
      );

      expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
      expect(redis.publish).toHaveBeenCalledTimes(1);
      expect(JSON.parse(redis.publish.mock.calls[0][1]).steamId).toBe("3");
    });
  });

  describe("matchmaking:confirm", () => {
    it("rejects confirmation from an unaccepted player and never calls playerConfirmMatchmaking", async () => {
      terms.hasAcceptedCurrentTerms.mockResolvedValue(false);

      await gateway.playerConfirmation(
        { confirmationId: "conf-1" },
        client(leader.steam_id),
      );

      expect(matchmakeService.playerConfirmMatchmaking).not.toHaveBeenCalled();
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(redis.publish.mock.calls[0][1]);
      expect(payload.steamId).toBe(leader.steam_id);
      expect(payload.event).toBe("matchmaking:error");
    });

    it("proceeds to playerConfirmMatchmaking for an accepted player", async () => {
      terms.hasAcceptedCurrentTerms.mockResolvedValue(true);

      await gateway.playerConfirmation(
        { confirmationId: "conf-1" },
        client(leader.steam_id),
      );

      expect(matchmakeService.playerConfirmMatchmaking).toHaveBeenCalledWith(
        "conf-1",
        leader.steam_id,
      );
      expect(redis.publish).not.toHaveBeenCalled();
    });
  });
});
