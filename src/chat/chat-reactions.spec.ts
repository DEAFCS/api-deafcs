import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

describe("ChatService message reactions", () => {
  const player: User = {
    steam_id: "76561190000000123",
    name: "Player",
    role: "administrator",
  };
  const messageId = "123e4567-e89b-42d3-a456-426614174000";
  const message = {
    id: messageId,
    from: { steam_id: "76561190000000456", name: "Other" },
    message: "hello",
    timestamp: "2026-09-24T12:00:00.000Z",
  };

  let service: ChatService;
  let redis: any;
  let postgres: { query: jest.Mock };
  let hasura: { query: jest.Mock };
  let blocks: {
    getMyBlockedSteamIds: jest.Mock;
    isBlockedEitherDirection: jest.Mock;
  };
  let restrictions: { getStatus: jest.Mock };
  let pipeline: any;

  beforeEach(() => {
    const replies = new Map<string, string>([
      [`chat:global:global`, JSON.stringify({ user: player })],
      [`chat_global_global`, JSON.stringify(message)],
    ]);
    pipeline = {
      scard: jest.fn().mockReturnThis(),
      sismember: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };
    redis = {
      hget: jest.fn(async (key: string, field: string) =>
        field === player.steam_id && key.startsWith("chat:")
          ? (replies.get(key) ?? null)
          : key === `chat_global_global` && field === messageId
            ? (replies.get(key) ?? null)
            : null,
      ),
      sismember: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1, 2, 86400]),
      pipeline: jest.fn(() => pipeline),
      hgetall: jest.fn().mockResolvedValue({}),
      publish: jest.fn().mockResolvedValue(1),
    };
    postgres = { query: jest.fn().mockResolvedValue([]) };
    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) =>
        "players_by_pk" in query ? { players_by_pk: player } : {},
      ),
    };
    blocks = {
      getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
      isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
    };
    restrictions = {
      getStatus: jest.fn().mockResolvedValue({ active: false }),
    };
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      blocks as any,
      restrictions as any,
    );
    jest.spyOn(service, "to").mockResolvedValue(undefined);
  });

  function client() {
    return { id: "socket-1", user: { ...player } } as any;
  }

  it("toggles only an existing stable message and broadcasts a dedicated reaction event", async () => {
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(true);

    const [script, keyCount, messageKey, reactionKey, deletedKey, ...args] =
      redis.eval.mock.calls[0];
    expect(script).toContain("HPTTL");
    expect(script).toContain("SREM");
    expect(script).toContain("SADD");
    expect(script).toContain("PEXPIRE");
    expect(script.match(/\belse\b/g)).toHaveLength(1);
    expect(keyCount).toBe(3);
    expect(messageKey).toBe("chat_global_global");
    expect(reactionKey).toBe(`chat:reaction:${messageId}:heart`);
    expect(deletedKey).toBe(`chat:reaction:deleted:${messageId}`);
    expect(args).toEqual([
      messageId,
      JSON.stringify(message),
      player.steam_id,
      "chat",
    ]);
    expect(service.to).toHaveBeenCalledWith(
      ChatLobbyType.Global,
      "global",
      "reaction",
      {
        messageId,
        reaction: "heart",
        count: 2,
        active: true,
        actorSteamId: player.steam_id,
      },
    );
  });

  it("rejects unstable IDs, unknown reactions, absent socket membership, and withdrawn tournament access", async () => {
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        "legacy-id",
        "heart",
      ),
    ).resolves.toBe(false);
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "custom-emoji",
      ),
    ).resolves.toBe(false);

    redis.sismember.mockResolvedValueOnce(0);
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);

    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: player });
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockResolvedValue(false);
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Tournament,
        "tournament-1",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("rejects restricted, muted, deleted, and viewer-redacted messages", async () => {
    restrictions.getStatus.mockResolvedValueOnce({ active: true });
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);

    postgres.query.mockResolvedValueOnce([{ remove_sanction_date: null }]);
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);

    restrictions.getStatus.mockResolvedValue({ active: false });
    postgres.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: messageId }]);
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);

    postgres.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    blocks.getMyBlockedSteamIds.mockResolvedValueOnce(
      new Set([message.from.steam_id]),
    );
    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Global,
        "global",
        messageId,
        "heart",
      ),
    ).resolves.toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("rechecks accepted-friend and bidirectional-block access for direct messages", async () => {
    hasura.query.mockResolvedValue({
      friends: [{ player_steam_id: player.steam_id }],
    });
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: player });
    const otherSteamId = "76561190000000456";
    const directRoom = [player.steam_id, otherSteamId].sort().join(":");

    await expect(
      (service as any).hasCurrentChatRoomAccess(
        client(),
        ChatLobbyType.Direct,
        directRoom,
        player,
      ),
    ).resolves.toBe(true);

    blocks.isBlockedEitherDirection.mockResolvedValueOnce(true);
    await expect(
      (service as any).hasCurrentChatRoomAccess(
        client(),
        ChatLobbyType.Direct,
        directRoom,
        player,
      ),
    ).resolves.toBe(false);
  });

  it("keeps announcement reaction keys persistent and clears all keys on deletion", async () => {
    const announcementId = "123e4567-e89b-42d3-a456-426614174001";
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: player });
    postgres.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: announcementId }]);

    await expect(
      service.toggleChatMessageReaction(
        client(),
        ChatLobbyType.Announcement,
        "announcement",
        announcementId,
        "party",
      ),
    ).resolves.toBe(true);
    const script = redis.eval.mock.calls[0][0] as string;
    expect(script).toContain("PERSIST");
    expect(redis.eval.mock.calls[0][8]).toBe("announcement");

    await (service as any).clearChatMessageReactions(announcementId);
    expect(redis.eval.mock.calls[1][1]).toBe(5);
    expect(redis.eval.mock.calls[1].slice(2, 7)).toEqual([
      `chat:reaction:deleted:${announcementId}`,
      `chat:reaction:${announcementId}:thumbsup`,
      `chat:reaction:${announcementId}:heart`,
      `chat:reaction:${announcementId}:fire`,
      `chat:reaction:${announcementId}:party`,
    ]);
    expect(redis.eval.mock.calls[1][0]).toContain("DEL");
  });

  it("loads only positive reaction counts and viewer-specific state for visible messages", async () => {
    pipeline.exec.mockResolvedValue([
      [null, 2],
      [null, 1],
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 3],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 0],
    ]);
    const messages = [
      { ...message },
      { ...message, id: "blocked", blocked: true },
      { ...message, id: "legacy-message-id" },
    ];

    await expect(
      (service as any).addReactionStateToMessages(messages, player.steam_id),
    ).resolves.toEqual([
      {
        ...message,
        reactions: [
          { reaction: "thumbsup", count: 2, reacted: true },
          { reaction: "fire", count: 1, reacted: false },
        ],
      },
      { ...message, id: "blocked", blocked: true, reactions: [] },
      { ...message, id: "legacy-message-id", reactions: [] },
    ]);
    expect(pipeline.scard).toHaveBeenCalledTimes(4);
    expect(pipeline.sismember).toHaveBeenCalledTimes(4);
  });
});
