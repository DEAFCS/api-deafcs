import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

// Chat pushes go straight from the conversation (5Stack e70aaadd) instead of
// through a notifications row and its event trigger. Direct messages are the
// one exception: the web still reads their ChatMessage row back to open a
// first conversation and restore its unread badge after a reload.
describe("ChatService direct chat push", () => {
  const sender: User = {
    steam_id: "76561190000000001",
    name: "Sender",
    role: "verified_user",
  };
  const member = "76561190000000002";
  const blocker = "76561190000000003";
  const mentioned = "76561190000000004";
  const organizer = "76561190000000005";

  let service: ChatService;
  let hasura: { query: jest.Mock };
  let redis: { publish: jest.Mock };
  let notifications: { notifyPlayers: jest.Mock; sendSilent: jest.Mock };
  let push: { sendChatMessage: jest.Mock };
  let blocks: { getViewersBlocking: jest.Mock };

  const players = [
    { steam_id: sender.steam_id, role: "verified_user" },
    { steam_id: member, role: "verified_user" },
    { steam_id: blocker, role: "verified_user" },
    { steam_id: mentioned, role: "verified_user" },
    { steam_id: organizer, role: "match_organizer" },
    { steam_id: "76561190000000006", role: "user" },
  ];

  beforeEach(() => {
    hasura = { query: jest.fn().mockResolvedValue({ players }) };
    redis = { publish: jest.fn().mockResolvedValue(1) };
    notifications = {
      notifyPlayers: jest.fn().mockResolvedValue(undefined),
      sendSilent: jest.fn().mockResolvedValue(undefined),
    };
    push = { sendChatMessage: jest.fn().mockResolvedValue(undefined) };
    blocks = {
      getViewersBlocking: jest.fn(
        async (candidates: string[]) =>
          new Set(candidates.filter((steamId) => steamId === blocker)),
      ),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      notifications as any,
      blocks as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
      undefined,
      undefined,
      push as any,
    );
  });

  function notify(
    type: ChatLobbyType,
    id: string,
    message = "hello",
    mentions: Array<{ steam_id: string; name: string }> = [],
  ) {
    return (service as any).notifyLobbyMembers(
      type,
      id,
      sender,
      message,
      mentions,
      "message-1",
    );
  }

  function pushes() {
    return push.sendChatMessage.mock.calls.map(([steamIds, data]) => ({
      steamIds: [...steamIds].sort(),
      ...data,
    }));
  }

  function expectNoNewRows() {
    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    expect(notifications.sendSilent).not.toHaveBeenCalled();
  }

  function rosterOf(steamIds: string[]) {
    jest
      .spyOn(service as any, "getLobbyMemberSteamIds")
      .mockResolvedValue(steamIds);
  }

  describe("Global", () => {
    it("pushes verified players directly, without a notifications row", async () => {
      await notify(ChatLobbyType.Global, "global");

      expectNoNewRows();
      expect(pushes()).toEqual([
        expect.objectContaining({
          steamIds: [member, mentioned, organizer].sort(),
          type: "GlobalChatMessage",
          entityId: "global:global",
          messageId: "message-1",
          senderSteamId: sender.steam_id,
          message: "hello",
        }),
      ]);
    });

    it("leaves out the sender, a base user and a player who blocked the sender", async () => {
      await notify(ChatLobbyType.Global, "global");

      const [{ steamIds }] = pushes();
      expect(steamIds).not.toContain(sender.steam_id);
      expect(steamIds).not.toContain("76561190000000006");
      expect(steamIds).not.toContain(blocker);
    });

    it("sends a mentioned player only the mention push, never both", async () => {
      await notify(ChatLobbyType.Global, "global", "hi @Mentioned", [
        { steam_id: mentioned, name: "Mentioned" },
      ]);

      const [broadcast, mention] = pushes();
      expect(broadcast.steamIds).not.toContain(mentioned);
      expect(mention).toEqual(
        expect.objectContaining({
          steamIds: [mentioned],
          type: "ChatMessage",
          title: expect.stringMatching(/mentioned you$/),
          entityId: "global:global",
        }),
      );
      expectNoNewRows();
    });

    it("still sends the unread-badge socket ping to the same audience", async () => {
      await notify(ChatLobbyType.Global, "global");

      const pinged = redis.publish.mock.calls.map(
        ([, payload]) => JSON.parse(payload).steamId,
      );
      expect(pinged.sort()).toEqual(
        [member, blocker, mentioned, organizer].sort(),
      );
    });
  });

  describe("Announcements", () => {
    it("pushes every player directly, including one who blocked the author", async () => {
      await notify(ChatLobbyType.Announcement, "announcement");

      expectNoNewRows();
      const [announcement] = pushes();
      expect(announcement.type).toBe("AnnouncementChatMessage");
      expect(announcement.steamIds).toEqual(
        players
          .map(({ steam_id }) => steam_id)
          .filter((steamId) => steamId !== sender.steam_id)
          .sort(),
      );
      expect(blocks.getViewersBlocking).not.toHaveBeenCalled();
    });
  });

  describe("Organizer (Admin) chat", () => {
    it("pushes only match organizers and above", async () => {
      await notify(ChatLobbyType.Organizer, "organizers");

      expectNoNewRows();
      expect(pushes()).toEqual([
        expect.objectContaining({
          steamIds: [organizer],
          type: "OrganizerChatMessage",
        }),
      ]);
    });
  });

  describe("Fixed-roster rooms", () => {
    it.each([
      [ChatLobbyType.Tournament, "tournament-1"],
      [ChatLobbyType.MatchMaking, "lobby-1"],
    ])(
      "%s chat pushes its members directly, minus the sender and blockers",
      async (type, id) => {
        rosterOf([sender.steam_id, member, blocker]);

        await notify(type, id);

        expectNoNewRows();
        expect(pushes()).toEqual([
          expect.objectContaining({
            steamIds: [member],
            type: "ChatMessage",
            entityId: `${type}:${id}`,
          }),
        ]);
      },
    );

    it("never pushes a non-member of a tournament", async () => {
      rosterOf([sender.steam_id, member]);

      await notify(ChatLobbyType.Tournament, "tournament-1");

      expect(pushes()[0].steamIds).toEqual([member]);
    });

    it("pushes a mentioned member once, as a mention", async () => {
      rosterOf([sender.steam_id, member, mentioned]);

      await notify(ChatLobbyType.Tournament, "tournament-1", "hi", [
        { steam_id: mentioned, name: "Mentioned" },
      ]);

      const [regular, mention] = pushes();
      expect(regular.steamIds).toEqual([member]);
      expect(mention).toEqual(
        expect.objectContaining({
          steamIds: [mentioned],
          title: expect.stringMatching(/mentioned you$/),
        }),
      );
      expectNoNewRows();
    });
  });

  describe("Direct messages", () => {
    const roomId = [sender.steam_id, member].sort().join(":");

    it("keeps writing the ChatMessage row the web reads, and pushes nothing directly", async () => {
      rosterOf([sender.steam_id, member]);

      await notify(ChatLobbyType.Direct, roomId);

      expect(push.sendChatMessage).not.toHaveBeenCalled();
      expect(notifications.notifyPlayers).toHaveBeenCalledTimes(1);
      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "ChatMessage",
        expect.objectContaining({
          steamIds: [member],
          entity_id: `direct:${roomId}`,
        }),
      );
    });

    it("writes no row for a recipient who blocked the sender", async () => {
      rosterOf([sender.steam_id, blocker]);

      await notify(
        ChatLobbyType.Direct,
        [sender.steam_id, blocker].sort().join(":"),
      );

      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
      expect(push.sendChatMessage).not.toHaveBeenCalled();
    });
  });

  describe("Silent rooms", () => {
    it.each([
      [ChatLobbyType.Match, "match-1"],
      [ChatLobbyType.MatchTeam, "match-1:lineup-1"],
      [ChatLobbyType.Draft, "draft-1"],
    ])("%s chat pushes nothing and writes nothing", async (type, id) => {
      await notify(type, id);

      expect(push.sendChatMessage).not.toHaveBeenCalled();
      expectNoNewRows();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("Captain Pick team chat pushes nothing and writes nothing", async () => {
      await notify(ChatLobbyType.CaptainPickTeam, "draft-1:1");

      expect(push.sendChatMessage).not.toHaveBeenCalled();
      expectNoNewRows();
    });
  });

  describe("previewText", () => {
    it("names a sign-language video, GIF or file that carries no text", () => {
      expect(ChatService.previewText("", { media: { type: "video" } })).toBe(
        "Video message",
      );
      expect(ChatService.previewText("", { gifUrl: "https://x" })).toBe(
        "GIF",
      );
      expect(ChatService.previewText("", { attachment: { id: "a" } })).toBe(
        "Attachment",
      );
    });

    it("keeps a message's own text", () => {
      expect(
        ChatService.previewText("look", { media: { type: "video" } }),
      ).toBe("look");
    });
  });

  describe("sending", () => {
    const tournamentId = "00000000-0000-0000-0000-000000000123";
    let logger: { warn: jest.Mock };

    beforeEach(() => {
      logger = { warn: jest.fn() };
      const sendRedis = {
        ...redis,
        hget: jest
          .fn()
          .mockResolvedValue(JSON.stringify({ user: sender })),
        hset: jest.fn().mockResolvedValue(1),
        eval: jest.fn(async (_script: string, _keys: number, key: string) =>
          key.startsWith("chat:message-rate:") ? 1 : [1, 1],
        ),
        get: jest.fn().mockResolvedValue(null),
        sendCommand: jest.fn().mockResolvedValue(1),
      };
      service = new ChatService(
        logger as any,
        {} as any,
        hasura as any,
        { query: jest.fn().mockResolvedValue([]) } as any,
        { getConnection: () => sendRedis } as any,
        notifications as any,
        {
          ...blocks,
          hasBlocked: jest.fn().mockResolvedValue(false),
        } as any,
        { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
        undefined,
        undefined,
        push as any,
      );
      jest
        .spyOn(service as any, "canAccessTournamentChat")
        .mockResolvedValue(true);
      jest.spyOn(service, "to").mockResolvedValue(undefined);
      rosterOf([sender.steam_id, member]);
    });

    async function flush() {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it("pushes the stored message's id, and writes no notifications row", async () => {
      const result = await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        tournamentId,
        sender,
        "hello",
      );
      await flush();

      expect(result).toEqual({ accepted: true });
      expect(push.sendChatMessage).toHaveBeenCalledWith(
        [member],
        expect.objectContaining({
          messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          message: "hello",
          entityId: `tournament:${tournamentId}`,
        }),
      );
      expectNoNewRows();
    });

    it("a failed push is logged and never fails the send", async () => {
      push.sendChatMessage.mockRejectedValue(new Error("push service down"));

      const result = await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        tournamentId,
        sender,
        "hello",
      );
      await flush();

      expect(result).toEqual({ accepted: true });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("push service down"),
      );
    });
  });
});
