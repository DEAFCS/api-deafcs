import {
  CHAT_REACTION_IDS,
  ChatService,
  canStaffReadMatchChat,
} from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// Moderators may read a live match's shared Match Chat (Anders 2026-10-15),
// read only, and never a team's private chat because of their role. All of
// this is enforced here in the API; the web only decides what to show.
describe("ChatService moderator access to Match Chat", () => {
  const MATCH = "33333333-3333-4333-8333-333333333333";
  const LINEUP_1 = "44444444-4444-4444-8444-444444444441";
  const LINEUP_2 = "44444444-4444-4444-8444-444444444442";
  const PLAYER_1 = "76561190000000101";
  const PLAYER_2 = "76561190000000102";
  const COACH_1 = "76561190000000103";
  const MODERATOR = "76561190000000201";
  const MATCH_ORGANIZER = "76561190000000202";
  const ADMIN = "76561190000000203";
  const VERIFIED = "76561190000000301";
  const STREAMER = "76561190000000302";

  const ROLES: Record<string, string> = {
    [PLAYER_1]: "user",
    [PLAYER_2]: "verified_user",
    [COACH_1]: "user",
    [MODERATOR]: "moderator",
    [MATCH_ORGANIZER]: "match_organizer",
    [ADMIN]: "administrator",
    [VERIFIED]: "verified_user",
    [STREAMER]: "streamer",
  };
  const LINEUPS: Record<string, { players: string[]; coach: string | null }> = {
    [LINEUP_1]: { players: [PLAYER_1], coach: COACH_1 },
    [LINEUP_2]: { players: [PLAYER_2], coach: null },
  };

  let status: string;
  let service: ChatService;
  let hasura: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;

  const user = (steamId: string) =>
    ({ steam_id: steamId, name: `P${steamId.slice(-3)}`, role: ROLES[steamId] }) as any;

  // Mirrors the Hasura computed fields: is_match_organizer.sql treats
  // administrators and match organizers as organizers of every match.
  const matchFor = (steamId: string) => ({
    is_in_lineup: Object.values(LINEUPS).some((l) => l.players.includes(steamId)),
    is_coach: Object.values(LINEUPS).some((l) => l.coach === steamId),
    is_organizer: ["administrator", "match_organizer"].includes(ROLES[steamId]),
    status,
  });

  beforeEach(() => {
    status = "Live";
    hasura = {
      query: jest.fn(async (query: any, steamId: string) => {
        if (query.matches_by_pk) {
          return query.matches_by_pk.__args.id === MATCH
            ? { matches_by_pk: matchFor(String(steamId)) }
            : { matches_by_pk: null };
        }
        if (query.match_lineups_by_pk) {
          const lineup = LINEUPS[query.match_lineups_by_pk.__args.id];
          return {
            match_lineups_by_pk: lineup && {
              id: query.match_lineups_by_pk.__args.id,
              match_id: MATCH,
              coach_steam_id: lineup.coach,
              is_on_lineup: lineup.players.includes(String(steamId)),
              match: { status },
            },
          };
        }
        if (query.players_by_pk) {
          const id = String(query.players_by_pk.__args.steam_id);
          return { players_by_pk: { steam_id: id, role: ROLES[id] } };
        }
        return {};
      }),
    };
    redis = {
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      hget: jest.fn().mockResolvedValue(null),
      hset: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      hpexpire: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
      sismember: jest.fn().mockResolvedValue(1),
    };
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
  });

  const client = (steamId: string) =>
    ({
      id: `client-${steamId}`,
      user: user(steamId),
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  function stubJoinInternals() {
    const addUserToLobby = jest
      .spyOn(service as any, "addUserToLobby")
      .mockResolvedValue({ user: {}, inGame: false });
    jest.spyOn(service as any, "addSession").mockResolvedValue([1, 1]);
    jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([]);
    jest.spyOn(service as any, "getDeletedMessageIds").mockResolvedValue(new Set());
    jest
      .spyOn(service as any, "addReactionStateToMessages")
      .mockImplementation(async (messages: any) => messages);
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
    return addUserToLobby;
  }

  const canRead = (type: ChatLobbyType, id: string, steamId: string) =>
    (service as any).hasLobbyPermission(type, id, user(steamId));

  describe("reading the shared Match Chat", () => {
    it.each(["Scheduled", "Veto", "WaitingForServer", "Live", "Finished"])(
      "lets a moderator join and read it while %s",
      async (s) => {
        status = s;
        const addUserToLobby = stubJoinInternals();
        const c = client(MODERATOR);
        await service.joinMatchLobby(c, ChatLobbyType.Match, MATCH);
        expect(addUserToLobby).toHaveBeenCalled();
        await expect(canRead(ChatLobbyType.Match, MATCH, MODERATOR)).resolves.toBe(true);
      },
    );

    it.each([VERIFIED, STREAMER])(
      "still refuses a non-staff outsider (%s)",
      async (steamId) => {
        const addUserToLobby = stubJoinInternals();
        await service.joinMatchLobby(client(steamId), ChatLobbyType.Match, MATCH);
        expect(addUserToLobby).not.toHaveBeenCalled();
        await expect(canRead(ChatLobbyType.Match, MATCH, steamId)).resolves.toBe(false);
      },
    );

    it("keeps players, coaches and administrators exactly as before", async () => {
      for (const steamId of [PLAYER_1, PLAYER_2, COACH_1, ADMIN, MATCH_ORGANIZER]) {
        await expect(canRead(ChatLobbyType.Match, MATCH, steamId)).resolves.toBe(true);
      }
    });

    it("is staff from moderator up only", () => {
      expect(canStaffReadMatchChat("moderator" as any)).toBe(true);
      expect(canStaffReadMatchChat("administrator" as any)).toBe(true);
      expect(canStaffReadMatchChat("streamer" as any)).toBe(false);
      expect(canStaffReadMatchChat("verified_user" as any)).toBe(false);
      expect(canStaffReadMatchChat("user" as any)).toBe(false);
    });
  });

  describe("Team Chat stays private", () => {
    it.each(["Scheduled", "Veto", "WaitingForServer", "Live"])(
      "refuses a moderator either team's chat while %s",
      async (s) => {
        status = s;
        const addUserToLobby = stubJoinInternals();
        for (const lineup of [LINEUP_1, LINEUP_2]) {
          await service.joinMatchLobby(
            client(MODERATOR),
            ChatLobbyType.MatchTeam,
            `${MATCH}:${lineup}`,
          );
          await expect(
            canRead(ChatLobbyType.MatchTeam, `${MATCH}:${lineup}`, MODERATOR),
          ).resolves.toBe(false);
        }
        expect(addUserToLobby).not.toHaveBeenCalled();
      },
    );

    it("keeps each team's own access and the post-match staff log unchanged", async () => {
      await expect(
        canRead(ChatLobbyType.MatchTeam, `${MATCH}:${LINEUP_1}`, PLAYER_1),
      ).resolves.toBe(true);
      await expect(
        canRead(ChatLobbyType.MatchTeam, `${MATCH}:${LINEUP_1}`, COACH_1),
      ).resolves.toBe(true);
      await expect(
        canRead(ChatLobbyType.MatchTeam, `${MATCH}:${LINEUP_1}`, PLAYER_2),
      ).resolves.toBe(false);

      status = "Finished";
      await expect(
        canRead(ChatLobbyType.MatchTeam, `${MATCH}:${LINEUP_2}`, MODERATOR),
      ).resolves.toBe(true);
    });

    it("does not give a moderator Captain Pick team chat", async () => {
      const addUserToLobby = stubJoinInternals();
      await service.joinMatchLobby(
        client(MODERATOR),
        ChatLobbyType.CaptainPickTeam,
        "draft-1:1",
      );
      expect(addUserToLobby).not.toHaveBeenCalled();
    });
  });

  describe("posting stays with the match's own people", () => {
    beforeEach(() => {
      jest
        .spyOn(service as any, "getUserData")
        .mockResolvedValue({ user: {}, inGame: false });
      jest
        .spyOn(service as any, "getWebsiteChatMuteStatus")
        .mockResolvedValue({ active: false });
      jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest.spyOn(service as any, "notifyLobbyMembers").mockResolvedValue(undefined);
      jest.spyOn(service, "sendChatToServer").mockResolvedValue(undefined as any);
    });

    const send = (steamId: string) =>
      service.sendMessageToChat(
        ChatLobbyType.Match,
        MATCH,
        user(steamId),
        "gg",
        false,
        "tab-1",
      );

    it("refuses a moderator's message, so nothing reaches the room or the game server", async () => {
      await expect(send(MODERATOR)).resolves.toEqual({ accepted: false });
      expect(redis.hset).not.toHaveBeenCalled();
      expect(service.sendChatToServer).not.toHaveBeenCalled();
    });

    it("still accepts players, coaches and administrators", async () => {
      for (const steamId of [PLAYER_1, COACH_1, ADMIN]) {
        await expect(send(steamId)).resolves.toEqual({ accepted: true });
      }
    });

    it("refuses a moderator's reaction in Match Chat, and lets a player's through the gate", async () => {
      jest.spyOn(service as any, "hasCurrentChatRoomAccess").mockResolvedValue(true);
      const gate = jest.spyOn(service as any, "isMatchChatParticipant");
      const react = (steamId: string) =>
        service.toggleChatMessageReaction(
          client(steamId),
          ChatLobbyType.Match,
          MATCH,
          "55555555-5555-4555-8555-555555555555",
          CHAT_REACTION_IDS[0],
        );

      await expect(react(MODERATOR)).resolves.toBe(false);
      await expect(gate.mock.results[0].value).resolves.toBe(false);

      await react(PLAYER_1);
      await expect(gate.mock.results[1].value).resolves.toBe(true);
    });
  });
});
