import { Logger } from "@nestjs/common";
import { SocketsService } from "./sockets.service";

function build() {
  const handlers: Record<string, (channel: string, message: string) => void> = {};
  const sub = {
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, handler: any) => {
      handlers[event] = handler;
    }),
  };
  // No presence keys exist at all: delivery must not depend on them.
  const redis = { keys: jest.fn().mockResolvedValue([]) };
  const redisManager = {
    getConnection: jest.fn((name?: string) => (name === "sub" ? sub : redis)),
  };
  const service = new SocketsService(
    new Logger("test"),
    { get: jest.fn().mockReturnValue({ name: "test" }) } as any,
    {} as any,
    redisManager as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const connect = (steamId: string, id: string) => {
    const client: any = { id, user: { steam_id: steamId }, send: jest.fn() };
    (service as any).clients.set(id, client);
    (service as any).indexClient(steamId, id);
    return client;
  };

  return { service, redis, handlers, connect };
}

describe("SocketsService targeted delivery", () => {
  it("delivers to an open socket even when its 20s presence key has expired", async () => {
    const { service, redis, connect } = build();
    const client = connect("1", "c1");

    await service.sendMessageToSteamId("1", "matchmaking:details", { x: 1 });

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "matchmaking:details", data: { x: 1 } }),
    );
    expect(redis.keys).not.toHaveBeenCalled();
  });

  it("delivers to every open socket of the player and nobody else", async () => {
    const { service, connect } = build();
    const a = connect("1", "c1");
    const b = connect("1", "c2");
    const other = connect("2", "c3");

    await service.sendMessageToSteamId("1", "ping", {});

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });

  it("stops delivering once a socket is removed", async () => {
    const { service, connect } = build();
    const client = connect("1", "c1");
    (service as any).clients.delete("c1");
    (service as any).unindexClient("1", "c1");

    await service.sendMessageToSteamId("1", "ping", {});

    expect(client.send).not.toHaveBeenCalled();
    expect((service as any).clientsBySteamId.has("1")).toBe(false);
  });

  it("ignores a player with no open socket on this node", async () => {
    const { service } = build();
    await expect(service.sendMessageToSteamId("9", "ping", {})).resolves.toBeUndefined();
  });

  it("is what the send-message-to-steam-id channel invokes", async () => {
    const { handlers, connect } = build();
    const client = connect("1", "c1");

    handlers["message"](
      "send-message-to-steam-id",
      JSON.stringify({ steamId: "1", event: "matchmaking:details", data: { ok: true } }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "matchmaking:details", data: { ok: true } }),
    );
  });
});

describe("SocketsService ready check delivery logging", () => {
  it("logs a ready check update that reaches no open socket", async () => {
    const { service } = build();
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.sendMessageToSteamId("1", "matchmaking:details", {
      confirmation: { confirmationId: "c1" },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reached no open socket"));
  });

  it("stays quiet for other messages to an offline player", async () => {
    const { service } = build();
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.sendMessageToSteamId("1", "matchmaking:details", {});
    await service.sendMessageToSteamId("1", "chat:new-message", {});

    expect(warn).not.toHaveBeenCalled();
  });
});
