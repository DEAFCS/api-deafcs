import { ChatService } from "./chat.service";
import { ChatGateway } from "./chat.gateway";
import { ChatVideoController } from "./chat-video.controller";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

describe("website message rate (upstream d2d7f616)", () => {
  const player = {
    steam_id: "76561190000000001",
    name: "Player",
    role: "administrator",
  } as any;
  let service: ChatService;
  let redis: Record<string, jest.Mock>;
  let hasura: { query: jest.Mock };
  let postgres: { query: jest.Mock };
  let now: number;
  let rates: Map<string, { count: number; expiresAt: number }>;
  beforeEach(() => {
    now = 1000;
    rates = new Map();
    redis = {
      eval: jest.fn(
        async (
          _script: string,
          _keys: number,
          key: string,
          windowMs: number,
        ) => {
          let rate = rates.get(key);
          if (!rate || rate.expiresAt <= now)
            rate = { count: 0, expiresAt: now + windowMs };
          rate.count++;
          rates.set(key, rate);
          return rate.count;
        },
      ),
      get: jest.fn().mockResolvedValue(null),
      hset: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      sendCommand: jest.fn().mockResolvedValue(1),
    };
    hasura = { query: jest.fn() };
    postgres = {
      query: jest.fn().mockResolvedValue([{ id: "announcement-1" }]),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);
  });
  const send = (
    type = ChatLobbyType.Global,
    user = player,
    source: "website" | "game" = "website",
  ) =>
    service.sendMessageToChat(
      type,
      "room-1",
      user,
      "gg",
      true,
      "tab-1",
      undefined,
      source,
    );
  function expectNoSendWork() {
    for (const fn of [
      hasura.query,
      postgres.query,
      redis.get,
      redis.hset,
      service.to,
      (service as any).notifyLobbyMembers,
    ])
      expect(fn).not.toHaveBeenCalled();
  }
  it("refuses the sixth send across rooms before database, persistence or unread notification work", async () => {
    for (const type of [
      ChatLobbyType.Global,
      ChatLobbyType.Match,
      ChatLobbyType.Team,
      ChatLobbyType.Tournament,
      ChatLobbyType.Direct,
    ])
      await expect(send(type)).resolves.toEqual({ accepted: true });
    expect(redis.hset).toHaveBeenCalledTimes(5);
    expect((service as any).notifyLobbyMembers).toHaveBeenCalledTimes(5);
    expect(JSON.parse(redis.hset.mock.calls[0][2])).toMatchObject({
      clientId: "tab-1",
      source: "website",
    });
    jest.clearAllMocks();
    await expect(send(ChatLobbyType.Announcement)).resolves.toEqual({
      accepted: false,
      rateLimited: true,
    });
    expectNoSendWork();
  });
  it.each(Object.values(ChatLobbyType))(
    "shares the player budget for website sends in %s",
    async (type) => {
      for (let i = 0; i < 5; i++)
        await expect(send(type)).resolves.toEqual({ accepted: true });
      jest.clearAllMocks();
      await expect(send(type)).resolves.toEqual({
        accepted: false,
        rateLimited: true,
      });
      expectNoSendWork();
      expect(redis.eval.mock.calls[0].slice(1)).toEqual([
        1,
        "chat:message-rate:" + player.steam_id,
        3000,
      ]);
    },
  );

  it("shares a counter across API instances and admits only five concurrent sends", async () => {
    const other = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(other, "to").mockResolvedValue(undefined);
    jest.spyOn(other as any, "notifyLobbyMembers").mockResolvedValue(undefined);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? other : service).sendMessageToChat(
          ChatLobbyType.Global,
          "global",
          player,
          "gg",
          true,
        ),
      ),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(5);
    expect(results.filter((r) => r.rateLimited)).toHaveLength(5);
    expect(redis.hset).toHaveBeenCalledTimes(5);
  });
  it("keeps a fixed three-second window, isolates players, and recovers after expiry", async () => {
    for (let i = 0; i < 5; i++) await send();
    now = 3999;
    await expect(send()).resolves.toMatchObject({ rateLimited: true });
    await expect(
      send(ChatLobbyType.Global, { ...player, steam_id: "other" }),
    ).resolves.toMatchObject({ accepted: true });
    now = 4000;
    await expect(send()).resolves.toMatchObject({ accepted: true });
    const [script, ...args] = redis.eval.mock.calls[0];
    expect(args).toEqual([1, "chat:message-rate:" + player.steam_id, 3000]);
    expect(script).toContain("if count == 1 then");
    expect(script).toContain("PEXPIRE");
  });
  it("does not limit game-relayed chat after website spam", async () => {
    for (let i = 0; i < 6; i++) await send();
    redis.eval.mockClear();
    for (let i = 0; i < 10; i++)
      await expect(send(ChatLobbyType.Match, player, "game")).resolves.toEqual({
        accepted: true,
      });
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it("fails closed on Redis errors and allows a retry after recovery", async () => {
    redis.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(send()).rejects.toThrow("redis unavailable");
    expectNoSendWork();
    await expect(send()).resolves.toEqual({ accepted: true });
    expect(redis.hset).toHaveBeenCalledTimes(1);
  });
  it("counts retries after persistence failure without bypassing the budget", async () => {
    redis.hset.mockRejectedValueOnce(new Error("write failed"));
    await expect(send()).rejects.toThrow("write failed");
    expect(service.to).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++)
      await expect(send()).resolves.toEqual({ accepted: true });
    await expect(send()).resolves.toMatchObject({ rateLimited: true });
  });
  it("charges legitimate attachment-only messages to the same budget", async () => {
    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Global,
        "global",
        player,
        "",
        true,
        "tab-1",
        {
          url: "chat-attachments/" + player.steam_id + "/0123456789abcdef.png",
          contentType: "image/png",
        },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(JSON.parse(redis.hset.mock.calls[0][2])).toHaveProperty(
      "attachment",
    );
  });
});

describe("rate-limit responses", () => {
  it("sends a websocket error and never relays a rejected match message to RCON", async () => {
    const chat = {
      sendMessageToChat: jest
        .fn()
        .mockResolvedValue({ accepted: false, rateLimited: true }),
      sendChatToServer: jest.fn(),
    };
    const client = {
      user: { steam_id: "player", name: "Player", role: "verified_user" },
      send: jest.fn(),
    };
    await new ChatGateway(chat as any).lobby(
      { id: "match-1", type: ChatLobbyType.Match, message: "spam" },
      client as any,
    );
    expect(JSON.parse(client.send.mock.calls[0][0])).toMatchObject({
      event: "chat:send:error",
      data: { message: expect.stringContaining("too quickly") },
    });
    expect(chat.sendChatToServer).not.toHaveBeenCalled();
  });
  it.each(["sendOwned", "sendPhone"] as const)(
    "returns HTTP 429 for %s",
    async (method) => {
      const chat = {
        sendOwnedVideoDraft: jest
          .fn()
          .mockResolvedValue({ accepted: false, rateLimited: true }),
        sendPhoneVideoDraft: jest
          .fn()
          .mockResolvedValue({ accepted: false, rateLimited: true }),
      };
      const controller = new ChatVideoController(
        chat as any,
        {} as any,
        {} as any,
      );
      const result =
        method === "sendOwned"
          ? controller.sendOwned("draft-1", {
              user: { steam_id: "player" },
            } as any)
          : controller.sendPhone("Bearer " + "T".repeat(43));
      await expect(result).rejects.toMatchObject({ status: 429 });
    },
  );
});
