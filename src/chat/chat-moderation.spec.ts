import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

describe("ChatService website moderation", () => {
  const administrator: User = {
    steam_id: "76561190000000001",
    name: "Admin",
    role: "administrator",
  };
  const player: User = {
    steam_id: "76561190000000002",
    name: "Player",
    role: "verified_user",
  };

  let service: ChatService;
  let hasura: { query: jest.Mock };
  let postgres: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;
  let websiteRestrictions: { getStatus: jest.Mock };

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
    websiteRestrictions = {
      getStatus: jest.fn().mockResolvedValue({ active: false }),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
        hasBlocked: jest.fn().mockResolvedValue(false),
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      websiteRestrictions as any,
    );
  });

  function client(user: User) {
    return { id: `socket-${user.steam_id}`, user: { ...user } } as any;
  }

  it("lets a current site administrator delete a Redis-backed message and broadcasts removal", async () => {
    hasura.query.mockResolvedValue({ players_by_pk: administrator });
    redis.hget.mockResolvedValue(
      JSON.stringify({
        id: "message-1",
        message: "evidence",
        timestamp: "2026-09-18T10:00:00.000Z",
        from: player,
      }),
    );
    postgres.query.mockResolvedValue([{ message_id: "message-1" }]);
    jest.spyOn(service, "to").mockResolvedValue(undefined);

    await expect(
      service.deleteMessage(
        client(administrator),
        ChatLobbyType.Global,
        "global",
        "message-1",
      ),
    ).resolves.toBe(true);

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("chat_message_deletions"),
      expect.arrayContaining([
        "message-1",
        ChatLobbyType.Global,
        "global",
        player.steam_id,
        "evidence",
        administrator.steam_id,
      ]),
    );
    expect(redis.hdel).toHaveBeenCalledWith(
      "chat_global_global",
      "message-1",
    );
    expect(service.to).toHaveBeenCalledWith(
      ChatLobbyType.Global,
      "global",
      "deleted",
      { id: "message-1" },
    );
  });

  it("does not let an ordinary player delete another player's message", async () => {
    hasura.query.mockResolvedValue({ players_by_pk: player });
    jest.spyOn(service, "to").mockResolvedValue(undefined);

    await expect(
      service.deleteMessage(
        client(player),
        ChatLobbyType.Global,
        "global",
        "message-1",
      ),
    ).resolves.toBe(false);

    expect(redis.hget).not.toHaveBeenCalledWith(
      "chat_global_global",
      "message-1",
    );
    expect(postgres.query).not.toHaveBeenCalled();
    expect(service.to).not.toHaveBeenCalled();
  });

  it("does not let a restricted administrator delete another player's message", async () => {
    hasura.query.mockResolvedValue({ players_by_pk: administrator });
    websiteRestrictions.getStatus.mockResolvedValue({ active: true });
    jest.spyOn(service, "to").mockResolvedValue(undefined);

    await expect(
      service.deleteMessage(
        client(administrator),
        ChatLobbyType.Global,
        "global",
        "message-1",
      ),
    ).resolves.toBe(false);

    expect(redis.hget).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
    expect(service.to).not.toHaveBeenCalled();
  });

  it("does not let a restricted administrator edit an announcement", async () => {
    websiteRestrictions.getStatus.mockResolvedValue({ active: true });
    jest.spyOn(service, "to").mockResolvedValue(undefined);

    hasura.query.mockResolvedValue({ players_by_pk: administrator });

    await expect(
      service.editAnnouncement(
        client(administrator),
        "323e4567-e89b-42d3-a456-426614174000",
        "edited text",
      ),
    ).resolves.toBe(false);

    expect(postgres.query).not.toHaveBeenCalled();
    expect(service.to).not.toHaveBeenCalled();
  });

  it("filters audited deletions out of Redis history after refresh", async () => {
    jest.spyOn(service as any, "refreshClientUser").mockResolvedValue(player);
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    redis.hgetall.mockResolvedValue({
      "message-1": JSON.stringify({
        id: "message-1",
        message: "deleted",
        timestamp: "2026-09-18T10:00:00.000Z",
        from: player,
      }),
      "message-2": JSON.stringify({
        id: "message-2",
        message: "visible",
        timestamp: "2026-09-18T10:01:00.000Z",
        from: player,
      }),
    });
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql.includes("chat_message_deletions")) {
        return [{ message_id: "message-1" }];
      }
      return [];
    });
    const client = {
      id: "socket-1",
      user: { ...player },
      send: jest.fn(),
      on: jest.fn(),
    };

    await service.joinMatchLobby(
      client as any,
      ChatLobbyType.Global,
      "global",
    );

    const history = client.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .find((payload) => payload.event === "lobby:global:global:messages");
    expect(history.data.messages).toHaveLength(1);
    expect(history.data.messages[0].id).toBe("message-2");
  });
});
