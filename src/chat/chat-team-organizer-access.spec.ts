import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// Team Chat (one private room per team) and Organizer Chat (moderators and
// above). Every rule here is enforced by the API: the web only decides what to
// show.
describe("ChatService team and organizer chat access", () => {
  const TEAM_A = "11111111-1111-4111-8111-111111111111";
  const TEAM_B = "22222222-2222-4222-8222-222222222222";
  const ADMIN = "76561190000000001";
  const CAPTAIN = "76561190000000002";
  const STARTER = "76561190000000003";
  const SUBSTITUTE = "76561190000000004";
  const BENCHED = "76561190000000005";
  const COACH = "76561190000000006";
  const OWNER_ONLY = "76561190000000007";
  const PENDING_INVITE = "76561190000000008";
  const FORMER_MEMBER = "76561190000000009";
  const STRANGER = "76561190000000010";
  const OTHER_TEAM_ONLY = "76561190000000011";

  // What the database holds. team_invites rows (pending/rejected) are not
  // roster rows, and a removed member's roster row no longer exists.
  let roster: Array<{
    team_id: string;
    player_steam_id: string;
    role: string;
    status: string;
    coach: boolean;
  }>;
  let owners: Record<string, string>;
  let roles: Record<string, string>;

  let service: ChatService;
  let postgres: { query: jest.Mock };
  let hasura: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;

  const user = (steamId: string, role = "user") =>
    ({ steam_id: steamId, name: `P${steamId.slice(-2)}`, role }) as any;

  beforeEach(() => {
    roster = [
      row(TEAM_A, ADMIN, "Admin", "Starter"),
      row(TEAM_A, CAPTAIN, "Invite", "Starter"),
      row(TEAM_A, STARTER, "Member", "Starter"),
      row(TEAM_A, SUBSTITUTE, "Member", "Substitute"),
      row(TEAM_A, BENCHED, "Member", "Benched"),
      row(TEAM_A, COACH, "Member", "Benched", true),
      row(TEAM_B, OTHER_TEAM_ONLY, "Admin", "Starter"),
      row(TEAM_B, STARTER, "Member", "Starter"),
    ];
    owners = { [TEAM_A]: OWNER_ONLY, [TEAM_B]: OTHER_TEAM_ONLY };
    roles = {};

    postgres = {
      query: jest.fn(async (sql: string, params: string[]) => {
        if (/AS allowed/.test(sql)) {
          const [teamId, steamId] = params;
          return [
            {
              allowed:
                roster.some(
                  (r) => r.team_id === teamId && r.player_steam_id === steamId,
                ) || owners[teamId] === steamId,
            },
          ];
        }
        if (/FROM team_roster WHERE team_id/.test(sql)) {
          const [teamId] = params;
          return [
            ...roster
              .filter((r) => r.team_id === teamId)
              .map((r) => ({ steam_id: r.player_steam_id })),
            ...(owners[teamId] ? [{ steam_id: owners[teamId] }] : []),
          ];
        }
        return [];
      }),
    };
    hasura = {
      query: jest.fn(async (query: any) => {
        if (query.players_by_pk) {
          const steamId = String(query.players_by_pk.__args.steam_id);
          return {
            players_by_pk: { steam_id: steamId, role: roles[steamId] ?? "user" },
          };
        }
        if (query.players) {
          const ids: string[] = query.players.__args?.where?.steam_id?._in;
          return {
            players: (ids ?? Object.keys(roles)).map((steamId) => ({
              steam_id: steamId,
              role: roles[steamId] ?? "user",
            })),
          };
        }
        return {};
      }),
    };
    redis = {
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      hset: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      hpexpire: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
  });

  function row(
    team_id: string,
    player_steam_id: string,
    role: string,
    status: string,
    coach = false,
  ) {
    return { team_id, player_steam_id, role, status, coach };
  }

  describe("Team Chat membership", () => {
    it.each([
      ["team administrator", ADMIN],
      ["captain", CAPTAIN],
      ["starting player", STARTER],
      ["substitute", SUBSTITUTE],
      ["benched player", BENCHED],
      ["coach", COACH],
      ["team owner", OWNER_ONLY],
    ])("allows the %s", async (_label, steamId) => {
      await expect(service.canAccessTeamChat(TEAM_A, steamId)).resolves.toBe(
        true,
      );
      await expect(
        (service as any).hasLobbyPermission(
          ChatLobbyType.Team,
          TEAM_A,
          user(steamId),
        ),
      ).resolves.toBe(true);
    });

    it.each([
      ["a pending or rejected invitation", PENDING_INVITE],
      ["a former member", FORMER_MEMBER],
      ["an unrelated player", STRANGER],
      ["a member of another team only", OTHER_TEAM_ONLY],
    ])("denies %s", async (_label, steamId) => {
      await expect(service.canAccessTeamChat(TEAM_A, steamId)).resolves.toBe(
        false,
      );
      await expect(
        (service as any).hasLobbyPermission(
          ChatLobbyType.Team,
          TEAM_A,
          user(steamId),
        ),
      ).resolves.toBe(false);
    });

    it("never treats an administrator of the site as a team member", async () => {
      await expect(
        (service as any).hasLobbyPermission(
          ChatLobbyType.Team,
          TEAM_A,
          user(STRANGER, "administrator"),
        ),
      ).resolves.toBe(false);
    });

    it("rejects malformed room and player ids without querying", async () => {
      await expect(service.canAccessTeamChat("not-a-uuid", ADMIN)).resolves.toBe(
        false,
      );
      await expect(service.canAccessTeamChat(TEAM_A, "abc")).resolves.toBe(
        false,
      );
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("reads the roster, not the invitations", async () => {
      await service.canAccessTeamChat(TEAM_A, ADMIN);
      const [sql] = postgres.query.mock.calls[0];
      expect(sql).toContain("team_roster");
      expect(sql).not.toContain("team_invites");
    });

    it("keeps each team's room separate for a player on two teams", async () => {
      expect(await service.canAccessTeamChat(TEAM_A, STARTER)).toBe(true);
      expect(await service.canAccessTeamChat(TEAM_B, STARTER)).toBe(true);
      expect(await service.canAccessTeamChat(TEAM_B, SUBSTITUTE)).toBe(false);
      expect(await service.canAccessTeamChat(TEAM_A, OTHER_TEAM_ONLY)).toBe(
        false,
      );
    });

    it("revokes access as soon as the roster row is removed", async () => {
      expect(await service.canAccessTeamChat(TEAM_A, STARTER)).toBe(true);
      roster = roster.filter(
        (r) => !(r.team_id === TEAM_A && r.player_steam_id === STARTER),
      );
      expect(await service.canAccessTeamChat(TEAM_A, STARTER)).toBe(false);
      expect(await service.canAccessTeamChat(TEAM_B, STARTER)).toBe(true);
    });

    it("lists the roster and owner as the room's members, for push and mentions", async () => {
      const members = await (service as any).getLobbyMemberSteamIds(
        ChatLobbyType.Team,
        TEAM_A,
      );
      expect(new Set(members)).toEqual(
        new Set([ADMIN, CAPTAIN, STARTER, SUBSTITUTE, BENCHED, COACH, OWNER_ONLY]),
      );
      expect(
        await (service as any).getLobbyMemberSteamIds(
          ChatLobbyType.Team,
          "not-a-uuid",
        ),
      ).toEqual([]);
    });
  });

  describe("Team Chat join, send and live delivery", () => {
    function client(steamId: string, role = "user") {
      roles[steamId] ??= role;
      return {
        id: `client-${steamId}`,
        user: user(steamId, role),
        send: jest.fn(),
        on: jest.fn(),
      } as any;
    }

    function stubJoinInternals() {
      const addUserToLobby = jest
        .spyOn(service as any, "addUserToLobby")
        .mockResolvedValue({ user: {}, inGame: false });
      jest.spyOn(service as any, "addSession").mockResolvedValue([1, 1]);
      jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([]);
      jest
        .spyOn(service as any, "getDeletedMessageIds")
        .mockResolvedValue(new Set());
      jest
        .spyOn(service as any, "addReactionStateToMessages")
        .mockImplementation(async (messages: any) => messages);
      jest
        .spyOn(service as any, "getWebsiteChatMuteStatus")
        .mockResolvedValue({ active: false });
      redis.hgetall = jest.fn().mockResolvedValue({});
      (service as any).websiteRestrictions.getStatus = jest
        .fn()
        .mockResolvedValue({ active: false });
      return addUserToLobby;
    }

    it("lets a roster member join and get history", async () => {
      const addUserToLobby = stubJoinInternals();
      const c = client(SUBSTITUTE);
      await service.joinMatchLobby(c, ChatLobbyType.Team, TEAM_A);
      expect(addUserToLobby).toHaveBeenCalled();
      const events = c.send.mock.calls.map((call: any[]) =>
        JSON.parse(call[0]).event,
      );
      expect(events).toContain(`lobby:team:${TEAM_A}:messages`);
    });

    it.each([PENDING_INVITE, FORMER_MEMBER, STRANGER])(
      "refuses %s a join and sends no history",
      async (steamId) => {
        const addUserToLobby = stubJoinInternals();
        const c = client(steamId, "administrator");
        await service.joinMatchLobby(c, ChatLobbyType.Team, TEAM_A);
        expect(addUserToLobby).not.toHaveBeenCalled();
        expect(c.send).not.toHaveBeenCalled();
      },
    );

    it("accepts a message from a member and refuses a removed one", async () => {
      jest
        .spyOn(service as any, "getUserData")
        .mockResolvedValue({ user: {}, inGame: false });
      jest
        .spyOn(service as any, "getWebsiteChatMuteStatus")
        .mockResolvedValue({ active: false });
      jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest
        .spyOn(service as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);

      const send = (steamId: string) =>
        service.sendMessageToChat(
          ChatLobbyType.Team,
          TEAM_A,
          user(steamId),
          "hello team",
          false,
          "tab-1",
        );

      await expect(send(BENCHED)).resolves.toEqual({ accepted: true });

      roster = roster.filter((r) => r.player_steam_id !== BENCHED);
      await expect(send(BENCHED)).resolves.toEqual({ accepted: false });
      expect(redis.hset).toHaveBeenCalledTimes(1);
      await expect(send(STRANGER)).resolves.toEqual({ accepted: false });
    });

    it("refuses reactions and attachment viewing once the member is gone", async () => {
      const allowed = () =>
        (service as any).hasLobbyPermission(
          ChatLobbyType.Team,
          TEAM_A,
          user(COACH),
        );
      expect(await allowed()).toBe(true);
      roster = roster.filter((r) => r.player_steam_id !== COACH);
      expect(await allowed()).toBe(false);
    });

    it("stops delivering live events to a removed member and drops their presence", async () => {
      jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([
        { steamId: CAPTAIN },
        { steamId: STRANGER },
      ]);
      const removeUserData = jest
        .spyOn(service as any, "removeUserData")
        .mockResolvedValue(undefined);

      await service.to(ChatLobbyType.Team, TEAM_A, "chat", { id: "m1" });

      const delivered = redis.publish.mock.calls.map(
        (call: any[]) => JSON.parse(call[1]).steamId,
      );
      expect(delivered).toEqual([CAPTAIN]);
      expect(removeUserData).toHaveBeenCalledWith(
        ChatLobbyType.Team,
        TEAM_A,
        STRANGER,
      );
    });

    it("pushes team messages to the other members only, as the TEAM chat", async () => {
      const push = { sendChatMessage: jest.fn().mockResolvedValue(undefined) };
      (service as any).pushNotifications = push;

      await (service as any).notifyLobbyMembers(
        ChatLobbyType.Team,
        TEAM_A,
        user(ADMIN),
        "scrim at 8?",
        [],
        "message-1",
      );

      const [recipients, payload] = push.sendChatMessage.mock.calls[0];
      expect(new Set(recipients)).toEqual(
        new Set([CAPTAIN, STARTER, SUBSTITUTE, BENCHED, COACH, OWNER_ONLY]),
      );
      expect(payload.entityId).toBe(`team:${TEAM_A}`);
      expect(payload.title).toMatch(/^\[TEAM\]/);
    });
  });

  describe("Organizer Chat roles", () => {
    const canRead = (steamId: string) =>
      (service as any).hasLobbyPermission(
        ChatLobbyType.Organizer,
        "organizers",
        user(steamId),
      );

    it.each([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])("allows %s", async (role) => {
      roles[STARTER] = role;
      await expect(canRead(STARTER)).resolves.toBe(true);
    });

    it.each(["user", "verified_user", "streamer"])("denies %s", async (role) => {
      roles[STARTER] = role;
      await expect(canRead(STARTER)).resolves.toBe(false);
    });

    it("reads the role fresh, so a stale session cannot keep access", async () => {
      roles[STARTER] = "moderator";
      expect(await canRead(STARTER)).toBe(true);
      roles[STARTER] = "verified_user";
      // The caller's own copy still says moderator.
      await expect(
        (service as any).hasLobbyPermission(
          ChatLobbyType.Organizer,
          "organizers",
          user(STARTER, "moderator"),
        ),
      ).resolves.toBe(false);
    });

    it("lets a moderator join and refuses a streamer", async () => {
      jest
        .spyOn(service as any, "addUserToLobby")
        .mockResolvedValue({ user: {}, inGame: false });
      jest.spyOn(service as any, "addSession").mockResolvedValue([1, 1]);
      jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([]);
      jest
        .spyOn(service as any, "getDeletedMessageIds")
        .mockResolvedValue(new Set());
      jest
        .spyOn(service as any, "addReactionStateToMessages")
        .mockImplementation(async (messages: any) => messages);
      jest
        .spyOn(service as any, "getWebsiteChatMuteStatus")
        .mockResolvedValue({ active: false });
      redis.hgetall = jest.fn().mockResolvedValue({});

      roles[STARTER] = "moderator";
      const moderator = {
        id: "c1",
        user: user(STARTER, "moderator"),
        send: jest.fn(),
        on: jest.fn(),
      } as any;
      await service.joinMatchLobby(moderator, ChatLobbyType.Organizer, "organizers");
      expect(moderator.send).toHaveBeenCalled();

      roles[SUBSTITUTE] = "streamer";
      const streamer = {
        id: "c2",
        user: user(SUBSTITUTE, "streamer"),
        send: jest.fn(),
        on: jest.fn(),
      } as any;
      await service.joinMatchLobby(streamer, ChatLobbyType.Organizer, "organizers");
      expect(streamer.send).not.toHaveBeenCalled();
    });

    it("refuses sending after the role is removed, even on an open socket", async () => {
      jest
        .spyOn(service as any, "getUserData")
        .mockResolvedValue({ user: {}, inGame: false });
      jest
        .spyOn(service as any, "getWebsiteChatMuteStatus")
        .mockResolvedValue({ active: false });
      jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest
        .spyOn(service as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);

      const send = () =>
        service.sendMessageToChat(
          ChatLobbyType.Organizer,
          "organizers",
          user(STARTER, "moderator"),
          "hello staff",
          false,
          "tab-1",
        );

      roles[STARTER] = "moderator";
      await expect(send()).resolves.toEqual({ accepted: true });
      roles[STARTER] = "verified_user";
      await expect(send()).resolves.toEqual({ accepted: false });
      expect(redis.hset).toHaveBeenCalledTimes(1);
    });

    it("stops delivering live events to someone who lost the role", async () => {
      roles[ADMIN] = "administrator";
      roles[CAPTAIN] = "moderator";
      roles[STARTER] = "verified_user";
      jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([
        { steamId: ADMIN },
        { steamId: CAPTAIN },
        { steamId: STARTER },
      ]);
      jest.spyOn(service as any, "removeUserData").mockResolvedValue(undefined);

      await service.to(ChatLobbyType.Organizer, "organizers", "chat", {
        id: "m1",
      });

      const delivered = redis.publish.mock.calls.map(
        (call: any[]) => JSON.parse(call[1]).steamId,
      );
      expect(new Set(delivered)).toEqual(new Set([ADMIN, CAPTAIN]));
    });

    it("notifies moderators, and only roles that can read the room", async () => {
      roles[ADMIN] = "administrator";
      roles[CAPTAIN] = "moderator";
      roles[STARTER] = "streamer";
      roles[SUBSTITUTE] = "match_organizer";
      hasura.query.mockImplementation(async (query: any) =>
        query.players
          ? {
              players: Object.entries(roles).map(([steam_id, role]) => ({
                steam_id,
                role,
              })),
            }
          : {},
      );
      const push = { sendChatMessage: jest.fn().mockResolvedValue(undefined) };
      (service as any).pushNotifications = push;

      await (service as any).notifyLobbyMembers(
        ChatLobbyType.Organizer,
        "organizers",
        user(ADMIN, "administrator"),
        "ping",
        [],
        "message-1",
      );

      const [recipients] = push.sendChatMessage.mock.calls[0];
      expect(new Set(recipients)).toEqual(new Set([CAPTAIN, SUBSTITUTE]));
    });

    it("only offers @-mentions to people who can read the room", async () => {
      roles[CAPTAIN] = "moderator";
      roles[STARTER] = "streamer";
      const mentions = await (service as any).resolveMentions(
        ChatLobbyType.Organizer,
        "organizers",
        user(ADMIN, "administrator"),
        [CAPTAIN, STARTER],
        "website",
      );
      expect(mentions.map((m: any) => m.steam_id)).toEqual([CAPTAIN]);
    });
  });
});
