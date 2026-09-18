import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

describe("ChatService block enforcement", () => {
  const playerA: User = {
    steam_id: "76561190000000001",
    name: "PlayerA",
    role: "verified_user",
  };
  const playerB: User = {
    steam_id: "76561190000000002",
    name: "PlayerB",
    role: "verified_user",
  };

  let service: ChatService;
  let hasura: { query: jest.Mock };
  let postgres: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;
  let blocks: {
    isBlockedEitherDirection: jest.Mock;
    hasBlocked: jest.Mock;
    getMyBlockedSteamIds: jest.Mock;
    getViewersBlocking: jest.Mock;
  };

  beforeEach(() => {
    hasura = { query: jest.fn() };
    postgres = { query: jest.fn().mockResolvedValue([]) };
    redis = {
      hget: jest.fn(),
      hgetall: jest.fn().mockResolvedValue({}),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1]),
      get: jest.fn().mockResolvedValue(null),
      publish: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
    };
    blocks = {
      isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
      hasBlocked: jest.fn().mockResolvedValue(false),
      getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
      getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      { notifyPlayers: jest.fn(), sendSilent: jest.fn() } as any,
      blocks as any,
      {
        getStatus: jest.fn().mockResolvedValue({ active: false }),
      } as any,
    );
  });

  function directId() {
    return [playerA.steam_id, playerB.steam_id].sort().join(":");
  }

  describe("Direct messages", () => {
    it("refuses to join a DM room when a block exists between the two parties", async () => {
      hasura.query
        .mockResolvedValueOnce({ players_by_pk: playerA }) // refreshClientUser
        .mockResolvedValueOnce({ friends: [{ player_steam_id: playerA.steam_id }] }); // accepted-friend check
      blocks.isBlockedEitherDirection.mockResolvedValue(true);

      const client = {
        user: playerA,
        send: jest.fn(),
        on: jest.fn(),
      };

      await service.joinMatchLobby(
        client as any,
        ChatLobbyType.Direct,
        directId(),
      );

      // No lobby "list"/"messages" payload was ever sent -- join was refused.
      expect(client.send).not.toHaveBeenCalled();
      expect(blocks.isBlockedEitherDirection).toHaveBeenCalledWith(
        playerA.steam_id,
        playerB.steam_id,
      );
    });

    it("rejects sending a DM once blocked, even with an already-open tab (skipCheck path unaffected, explicit check path used)", async () => {
      blocks.isBlockedEitherDirection.mockResolvedValue(true);
      redis.hget.mockResolvedValue(JSON.stringify({ user: playerA }));

      const result = await service.sendMessageToChat(
        ChatLobbyType.Direct,
        directId(),
        playerA,
        "hello",
      );

      expect(result.accepted).toBe(false);
      expect(redis.hset).not.toHaveBeenCalled();
    });

    it("allows sending a DM when no block exists", async () => {
      blocks.isBlockedEitherDirection.mockResolvedValue(false);
      redis.hget.mockResolvedValue(JSON.stringify({ user: playerA }));
      jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest
        .spyOn(service as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);

      const result = await service.sendMessageToChat(
        ChatLobbyType.Direct,
        directId(),
        playerA,
        "hello",
      );

      expect(result.accepted).toBe(true);
    });
  });

  describe("Shared room live message redaction", () => {
    it("redacts the sender's message only for a recipient who blocked them, via to()'s redactForRecipient", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: playerA }));
      const toSpy = jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest
        .spyOn(service as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);

      await service.sendMessageToChat(
        ChatLobbyType.Global,
        "global",
        playerA,
        "hello everyone",
      );

      expect(toSpy).toHaveBeenCalledWith(
        ChatLobbyType.Global,
        "global",
        "chat",
        expect.objectContaining({ message: "hello everyone" }),
        expect.any(Function),
      );

      const redactFn = toSpy.mock.calls[0][4] as (
        steamId: string,
      ) => Promise<any>;

      // A recipient who has NOT blocked the sender gets the real message.
      blocks.hasBlocked.mockResolvedValueOnce(false);
      await expect(redactFn(playerB.steam_id)).resolves.toBeUndefined();

      // A recipient who HAS blocked the sender gets a redacted payload.
      blocks.hasBlocked.mockResolvedValueOnce(true);
      const redacted = await redactFn(playerB.steam_id);
      expect(redacted).toEqual(
        expect.objectContaining({
          message: "Message from blocked player",
          blocked: true,
        }),
      );

      // The sender always sees their own message, regardless of block state.
      await expect(redactFn(playerA.steam_id)).resolves.toBeUndefined();
    });

    it("does not attach redaction for Direct or Announcement rooms", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ user: playerA }));
      const toSpy = jest.spyOn(service, "to").mockResolvedValue(undefined);
      jest
        .spyOn(service as any, "notifyLobbyMembers")
        .mockResolvedValue(undefined);

      await service.sendMessageToChat(
        ChatLobbyType.Direct,
        directId(),
        playerA,
        "hi",
      );

      expect(toSpy).toHaveBeenCalledWith(
        ChatLobbyType.Direct,
        directId(),
        "chat",
        expect.objectContaining({ message: "hi" }),
      );
      expect(toSpy.mock.calls[0]).toHaveLength(4);
    });
  });

  describe("Shared room history redaction on join", () => {
    it("replaces a blocked sender's message content for the joining viewer only", async () => {
      hasura.query.mockResolvedValueOnce({ players_by_pk: playerA });
      redis.hgetall.mockResolvedValue({
        "msg-1": JSON.stringify({
          id: "msg-1",
          message: "hi from B",
          timestamp: "2026-09-18T10:00:00.000Z",
          from: { steam_id: playerB.steam_id, name: "PlayerB" },
        }),
        "msg-2": JSON.stringify({
          id: "msg-2",
          message: "hi from someone else",
          timestamp: "2026-09-18T10:01:00.000Z",
          from: { steam_id: "76561190000000099", name: "Other" },
        }),
      });
      blocks.getMyBlockedSteamIds.mockResolvedValue(
        new Set([playerB.steam_id]),
      );

      const client = { user: playerA, send: jest.fn(), on: jest.fn() };

      await service.joinMatchLobby(client as any, ChatLobbyType.Global, "global");

      const messagesCall = client.send.mock.calls
        .map(([payload]: [string]) => JSON.parse(payload))
        .find((p: any) => p.event === "lobby:global:global:messages");

      const fromB = messagesCall.data.messages.find(
        (m: any) => m.id === "msg-1",
      );
      const fromOther = messagesCall.data.messages.find(
        (m: any) => m.id === "msg-2",
      );

      expect(fromB.message).toBe("Message from blocked player");
      expect(fromB.blocked).toBe(true);
      expect(fromOther.message).toBe("hi from someone else");
      expect(fromOther.blocked).toBeUndefined();
    });

    it("does not query blocks at all when the viewer has blocked nobody", async () => {
      hasura.query.mockResolvedValueOnce({ players_by_pk: playerA });
      redis.hgetall.mockResolvedValue({
        "msg-1": JSON.stringify({
          id: "msg-1",
          message: "hi",
          timestamp: "2026-09-18T10:00:00.000Z",
          from: { steam_id: playerB.steam_id, name: "PlayerB" },
        }),
      });
      blocks.getMyBlockedSteamIds.mockResolvedValue(new Set());

      const client = { user: playerA, send: jest.fn(), on: jest.fn() };
      await service.joinMatchLobby(client as any, ChatLobbyType.Global, "global");

      const messagesCall = client.send.mock.calls
        .map(([payload]: [string]) => JSON.parse(payload))
        .find((p: any) => p.event === "lobby:global:global:messages");
      expect(messagesCall.data.messages[0].message).toBe("hi");
    });
  });

  describe("Personal push notifications", () => {
    it("excludes a recipient who has blocked the sender from notifyPlayers targets", async () => {
      const notifyPlayers = jest.fn().mockResolvedValue(undefined);
      const svc = new ChatService(
        { warn: jest.fn() } as any,
        {} as any,
        hasura as any,
        postgres as any,
        { getConnection: () => redis } as any,
        { notifyPlayers, sendSilent: jest.fn() } as any,
        blocks as any,
        {
          getStatus: jest.fn().mockResolvedValue({ active: false }),
        } as any,
      );

      jest
        .spyOn(svc as any, "getLobbyMemberSteamIds")
        .mockResolvedValue([playerA.steam_id, playerB.steam_id]);
      blocks.getViewersBlocking.mockResolvedValue(new Set([playerB.steam_id]));

      await (svc as any).notifyLobbyMembers(
        ChatLobbyType.Direct,
        directId(),
        playerA,
        "hello",
      );

      expect(blocks.getViewersBlocking).toHaveBeenCalledWith(
        [playerB.steam_id],
        playerA.steam_id,
      );
      expect(notifyPlayers).not.toHaveBeenCalled();
    });

    it("still notifies a recipient who has not blocked the sender", async () => {
      const notifyPlayers = jest.fn().mockResolvedValue(undefined);
      const svc = new ChatService(
        { warn: jest.fn() } as any,
        {} as any,
        hasura as any,
        postgres as any,
        { getConnection: () => redis } as any,
        { notifyPlayers, sendSilent: jest.fn() } as any,
        blocks as any,
        {
          getStatus: jest.fn().mockResolvedValue({ active: false }),
        } as any,
      );

      jest
        .spyOn(svc as any, "getLobbyMemberSteamIds")
        .mockResolvedValue([playerA.steam_id, playerB.steam_id]);
      blocks.getViewersBlocking.mockResolvedValue(new Set());

      await (svc as any).notifyLobbyMembers(
        ChatLobbyType.Direct,
        directId(),
        playerA,
        "hello",
      );

      expect(notifyPlayers).toHaveBeenCalledWith(
        "ChatMessage",
        expect.objectContaining({ steamIds: [playerB.steam_id] }),
      );
    });
  });
});
