import { MatchmakingGateway } from "./matchmaking.gateway";
import { CaptainPickActionError } from "./captain-pick/captain-pick.service";
import {
  CAPTAIN_PICK_COMMITTED_ERROR,
  CAPTAIN_PICK_DISABLED_ERROR,
  CAPTAIN_PICK_NOT_COMPETITIVE_ERROR,
  CAPTAIN_PICK_SOLO_ONLY_ERROR,
} from "./captain-pick/captain-pick-queue-rules";

// Covers the Terms-acceptance enforcement added to matchmaking:join-queue
// (party-wide -- an accepted leader must not be able to bring an unaccepted
// party member into the queue with them) and matchmaking:confirm
// (single-user), plus the Captain Pick queue rules. The rest of joinQueue's
// setting/region/latency plumbing is stubbed to the minimum needed to reach
// those checks, not re-tested here.
describe("MatchmakingGateway Terms enforcement", () => {
  let gateway: any;
  let hasura: { query: jest.Mock };
  let matchmakingLobbyService: {
    getPlayerLobby: jest.Mock;
    verifyLobby: jest.Mock;
    setLobbyDetails: jest.Mock;
    removeLobbyFromQueue: jest.Mock;
    removeLobbyDetails: jest.Mock;
  };
  let matchmakeService: {
    addLobbyToQueue: jest.Mock;
    sendRegionStats: jest.Mock;
    matchmake: jest.Mock;
    matchmakeQueue: jest.Mock;
    playerConfirmMatchmaking: jest.Mock;
    releaseLobbyLock: jest.Mock;
  };
  let cache: { lock: jest.Mock };
  let terms: { hasAcceptedCurrentTerms: jest.Mock };
  let redis: { publish: jest.Mock; hgetall: jest.Mock };
  let logger: { error: jest.Mock; log: jest.Mock };
  let captainPick: {
    getActiveDraftId: jest.Mock;
    pick: jest.Mock;
    publishState: jest.Mock;
  };
  let captainPickEnabled: boolean;
  let settingsRows: Array<{ name: string; value: string }>;

  const leader = { steam_id: "1", captain: true };
  const member = { steam_id: "2", captain: false };

  const lobby = { id: "lobby-1", players: [leader, member] };

  beforeEach(() => {
    settingsRows = [];
    hasura = {
      query: jest.fn((query: any) => {
        if (query.settings) return Promise.resolve({ settings: settingsRows });
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
      removeLobbyFromQueue: jest.fn().mockResolvedValue(true),
      removeLobbyDetails: jest.fn().mockResolvedValue(undefined),
    };
    matchmakeService = {
      addLobbyToQueue: jest.fn().mockResolvedValue(undefined),
      sendRegionStats: jest.fn().mockResolvedValue(undefined),
      matchmake: jest.fn().mockResolvedValue(undefined),
      matchmakeQueue: jest.fn().mockResolvedValue(undefined),
      playerConfirmMatchmaking: jest.fn().mockResolvedValue(undefined),
      releaseLobbyLock: jest.fn().mockResolvedValue(undefined),
    };
    cache = { lock: jest.fn((key: string, fn: () => unknown) => fn()) };
    terms = { hasAcceptedCurrentTerms: jest.fn() };
    redis = { publish: jest.fn().mockResolvedValue(undefined), hgetall: jest.fn().mockResolvedValue({}) };
    logger = { error: jest.fn(), log: jest.fn() };
    captainPickEnabled = true;
    captainPick = {
      getActiveDraftId: jest.fn().mockResolvedValue(null),
      pick: jest.fn().mockResolvedValue(undefined),
      publishState: jest.fn().mockResolvedValue(undefined),
    };

    gateway = Object.create(MatchmakingGateway.prototype);
    gateway.logger = logger;
    gateway.hasura = hasura;
    gateway.matchmakingLobbyService = matchmakingLobbyService;
    gateway.matchmakeService = matchmakeService;
    gateway.cache = cache;
    gateway.terms = terms;
    gateway.redis = redis;
    gateway.websiteRestrictions = {
      getStatus: jest.fn().mockResolvedValue({ active: false }),
      assertCanParticipate: jest.fn().mockResolvedValue(undefined),
    };
    gateway.captainPick = captainPick;
    gateway.captainPickSettings = {
      getSettings: jest.fn(async () => ({
        enabled: captainPickEnabled,
        pickSeconds: 30,
      })),
    };
  });

  const client = (steamId: string) => ({
    user: { steam_id: steamId, role: "user" },
    sessionId: "session-1",
  });

  const errorsSentTo = (steamId: string) =>
    redis.publish.mock.calls
      .map(([, payload]: [string, string]) => JSON.parse(payload))
      .filter(
        (message: any) =>
          message.steamId === steamId && message.event === "matchmaking:error",
      )
      .map((message: any) => message.data.message);

  describe("matchmaking:join-queue queue variants", () => {
    const solo = {
      id: "solo-lobby",
      players: [{ steam_id: "3", captain: true }],
    };

    beforeEach(() => {
      terms.hasAcceptedCurrentTerms.mockResolvedValue(true);
      matchmakingLobbyService.getPlayerLobby.mockResolvedValue(solo);
    });

    const join = (data: Record<string, unknown>, steamId = "3") =>
      gateway.joinQueue({ regions: ["TestA"], ...data }, client(steamId));

    it("queues as before when no variant is sent", async () => {
      await join({ type: "Competitive" });

      expect(matchmakingLobbyService.setLobbyDetails).toHaveBeenCalledWith(
        ["TestA"],
        "Competitive",
        solo,
        "Standard",
      );
      expect(matchmakeService.addLobbyToQueue).toHaveBeenCalledWith(solo.id);
      expect(matchmakeService.matchmakeQueue).toHaveBeenCalledWith(
        "Competitive",
        "TestA",
        "Standard",
      );
    });

    it("queues an explicit Standard request the same way", async () => {
      await join({ type: "Competitive", variant: "Standard" });

      expect(matchmakeService.addLobbyToQueue).toHaveBeenCalledWith(solo.id);
      expect(matchmakeService.matchmakeQueue).toHaveBeenCalledWith(
        "Competitive",
        "TestA",
        "Standard",
      );
    });

    it("queues a solo Competitive Captain Pick player into Captain Pick", async () => {
      await join({ type: "Competitive", variant: "CaptainPick" });

      expect(errorsSentTo("3")).toEqual([]);
      expect(matchmakingLobbyService.setLobbyDetails).toHaveBeenCalledWith(
        ["TestA"],
        "Competitive",
        solo,
        "CaptainPick",
      );
      expect(matchmakeService.matchmakeQueue).toHaveBeenCalledWith(
        "Competitive",
        "TestA",
        "CaptainPick",
      );
    });

    it("refuses Captain Pick while it is switched off", async () => {
      captainPickEnabled = false;

      await join({ type: "Competitive", variant: "CaptainPick" });

      expect(matchmakingLobbyService.setLobbyDetails).not.toHaveBeenCalled();
      expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
      expect(errorsSentTo("3")).toEqual([CAPTAIN_PICK_DISABLED_ERROR]);
    });

    it("refuses Captain Pick for a party, telling every member", async () => {
      matchmakingLobbyService.getPlayerLobby.mockResolvedValue(lobby);

      await join({ type: "Competitive", variant: "CaptainPick" }, "1");

      expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
      expect(errorsSentTo("1")).toEqual([CAPTAIN_PICK_SOLO_ONLY_ERROR]);
      expect(errorsSentTo("2")).toEqual([CAPTAIN_PICK_SOLO_ONLY_ERROR]);
    });

    it.each(["Wingman", "Duel"])(
      "refuses Captain Pick for %s",
      async (type) => {
        await join({ type, variant: "CaptainPick" });

        expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
        expect(errorsSentTo("3")).toEqual([CAPTAIN_PICK_NOT_COMPETITIVE_ERROR]);
      },
    );

    it("keeps Captain Pick independent of the Standard 5v5 switch", async () => {
      settingsRows = [
        { name: "public.matchmaking_competitive", value: "false" },
      ];

      await join({ type: "Competitive", variant: "CaptainPick" });
      expect(matchmakeService.addLobbyToQueue).toHaveBeenCalledWith(solo.id);

      await expect(join({ type: "Competitive" })).rejects.toThrow(
        "Matchmaking is not allowed",
      );
    });

    it("refuses unknown variants", async () => {
      await join({ type: "Competitive", variant: "Draft" });

      expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
      expect(errorsSentTo("3")).toEqual(["Unknown matchmaking queue"]);
    });

    it.each([
      ["Standard 5v5", "Competitive", undefined],
      ["Captain Pick", "Competitive", "CaptainPick"],
      ["2v2", "Wingman", undefined],
      ["1v1", "Duel", undefined],
    ])(
      "refuses %s while the player is committed to a Captain Pick draft",
      async (_label, type, variant) => {
        captainPick.getActiveDraftId.mockResolvedValue("draft-1");

        await join({ type, variant });

        expect(matchmakingLobbyService.setLobbyDetails).not.toHaveBeenCalled();
        expect(matchmakeService.addLobbyToQueue).not.toHaveBeenCalled();
        expect(errorsSentTo("3")).toEqual([CAPTAIN_PICK_COMMITTED_ERROR]);
      },
    );
  });

  describe("matchmaking:leave", () => {
    it("leaves the queue as before when not in a draft", async () => {
      await gateway.leaveQueue(client("1"));

      expect(matchmakingLobbyService.removeLobbyFromQueue).toHaveBeenCalledWith(
        lobby.id,
      );
      expect(matchmakingLobbyService.removeLobbyDetails).toHaveBeenCalledWith(
        lobby.id,
      );
    });

    it("cannot be used to escape a committed Captain Pick draft", async () => {
      captainPick.getActiveDraftId.mockResolvedValue("draft-1");

      await gateway.leaveQueue(client("1"));

      expect(matchmakeService.releaseLobbyLock).not.toHaveBeenCalled();
      expect(
        matchmakingLobbyService.removeLobbyFromQueue,
      ).not.toHaveBeenCalled();
      expect(matchmakingLobbyService.removeLobbyDetails).not.toHaveBeenCalled();
      expect(errorsSentTo("1")).toEqual([CAPTAIN_PICK_COMMITTED_ERROR]);
    });
  });

  describe("matchmaking:captain-pick", () => {
    beforeEach(() => {
      captainPick.getActiveDraftId.mockResolvedValue("draft-1");
    });

    const send = (data: Record<string, unknown>, steamId = "1") =>
      gateway.captainPickPlayer(data, client(steamId));

    it("picks as the authenticated user, ignoring any actor in the payload", async () => {
      await send({
        confirmationId: "draft-1",
        steamId: "7",
        pickIndex: 0,
        actor: "2",
        captainSteamId: "2",
      });

      expect(captainPick.pick).toHaveBeenCalledWith("draft-1", "1", "7", 0);
    });

    it("rejects a draft the user does not belong to", async () => {
      captainPick.getActiveDraftId.mockResolvedValue("another-draft");

      await send({ confirmationId: "draft-1", steamId: "7", pickIndex: 0 });

      expect(captainPick.pick).not.toHaveBeenCalled();
      expect(errorsSentTo("1")).toEqual(["You are not in this draft."]);
    });

    it.each([
      { steamId: "7", pickIndex: 0 },
      { confirmationId: "draft-1", pickIndex: 0 },
      { confirmationId: "draft-1", steamId: "7" },
      { confirmationId: "draft-1", steamId: "7", pickIndex: "0" },
      { confirmationId: "draft-1", steamId: { $ne: 1 }, pickIndex: 0 },
    ])("rejects a malformed pick %#", async (data) => {
      await send(data);

      expect(captainPick.pick).not.toHaveBeenCalled();
      expect(errorsSentTo("1")).toEqual(["Invalid pick."]);
    });

    it("reports a refused pick and resyncs the sender", async () => {
      captainPick.pick.mockRejectedValue(
        new CaptainPickActionError("It is not your turn to pick."),
      );

      await send(
        { confirmationId: "draft-1", steamId: "7", pickIndex: 0 },
        "5",
      );

      expect(errorsSentTo("5")).toEqual(["It is not your turn to pick."]);
      expect(captainPick.publishState).toHaveBeenCalledWith("draft-1", ["5"]);
    });
  });

  describe("matchmaking:captain-pick:match-status", () => {
    const repliesTo = (steamId: string) =>
      redis.publish.mock.calls
        .map(([, payload]: [string, string]) => JSON.parse(payload))
        .filter(
          (message: any) =>
            message.steamId === steamId &&
            message.event === "matchmaking:captain-pick:match-status",
        )
        .map((message: any) => message.data);

    beforeEach(() => {
      (captainPick as any).getMatchDraftStatus = jest.fn(
        async (_matchId: string, steamId: string) => ({
          active: true,
          participant: steamId === "5",
        }),
      );
    });

    it("answers only the asking player, using the server's own draft state", async () => {
      await gateway.captainPickMatchStatus({ matchId: "match-1" }, client("5") as any);
      await gateway.captainPickMatchStatus({ matchId: "match-1" }, client("999") as any);

      expect((captainPick as any).getMatchDraftStatus).toHaveBeenCalledWith("match-1", "5");
      expect(repliesTo("5")).toEqual([
        { matchId: "match-1", active: true, participant: true },
      ]);
      expect(repliesTo("999")).toEqual([
        { matchId: "match-1", active: true, participant: false },
      ]);
    });

    it("ignores guests and invalid input", async () => {
      await gateway.captainPickMatchStatus({ matchId: "match-1" }, { user: null } as any);
      await gateway.captainPickMatchStatus({ matchId: 42 } as any, client("5") as any);
      await gateway.captainPickMatchStatus({} as any, client("5") as any);

      expect((captainPick as any).getMatchDraftStatus).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });
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
