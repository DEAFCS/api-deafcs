import { Logger } from "@nestjs/common";
import { PassThrough } from "stream";
import { SocketsService } from "./sockets.service";
import { SocketsGateway } from "./sockets.gateway";
import { SystemGateway } from "../system/system.gateway.ts";
import { RconService } from "../rcon/rcon.service";

// Adapted from 5stackgg/api 52ee2873 (#602) sockets.service.spec: upstream
// refreshes the role in its heartbeat(); DEAFCS does it on the web's 15s
// ping. A demoted staff member's open tab loses RCON, the Logs stream and
// staff-only socket actions without being disconnected.

const STEAM_ID = "76561198000000001";

function makeService(role: unknown) {
  const redis = { set: jest.fn().mockResolvedValue("OK") };
  const hasura = { getPlayerRole: jest.fn().mockResolvedValue(role) };
  const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const service = new SocketsService(
    logger as any,
    { get: jest.fn().mockReturnValue({ name: "test" }) } as any,
    {} as any,
    {
      getConnection: () => ({ ...redis, subscribe: jest.fn(), on: jest.fn() }),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    hasura as any,
  );
  const gateway = new SocketsGateway(service, {} as any);
  return { service, gateway, hasura, logger };
}

function socket(role = "administrator") {
  return {
    id: "client-1",
    user: { steam_id: STEAM_ID, name: "Staff", role },
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
  } as any;
}

describe("socket role refresh on ping", () => {
  it("takes a demoted player's old role off their open socket", async () => {
    const { gateway, hasura } = makeService("user");
    const client = socket("administrator");
    const updateClient = jest
      .spyOn(SocketsService.prototype, "updateClient")
      .mockResolvedValue(undefined);

    await gateway.handleMessage(client);

    expect(hasura.getPlayerRole).toHaveBeenCalledWith(STEAM_ID);
    expect(client.user.role).toBe("user");
    expect(client.close).not.toHaveBeenCalled();
    expect(updateClient).toHaveBeenCalledWith(STEAM_ID, "client-1");
    updateClient.mockRestore();
  });

  it("gives a promoted player the new role without reconnecting", async () => {
    const { gateway } = makeService("moderator");
    const client = socket("user");
    jest
      .spyOn(SocketsService.prototype, "updateClient")
      .mockResolvedValue(undefined);

    await gateway.handleMessage(client);

    expect(client.user.role).toBe("moderator");
    expect(client.close).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it("closes the socket of a player who no longer exists", async () => {
    const { gateway } = makeService(undefined);
    const client = socket();
    const updateClient = jest
      .spyOn(SocketsService.prototype, "updateClient")
      .mockResolvedValue(undefined);

    await gateway.handleMessage(client);

    expect(client.close).toHaveBeenCalled();
    expect(updateClient).not.toHaveBeenCalled();
    updateClient.mockRestore();
  });

  it("keeps the socket open, and still answers pong, when the role cannot be read", async () => {
    const { gateway, hasura } = makeService("user");
    hasura.getPlayerRole.mockRejectedValue(new Error("hasura is down"));
    const client = socket("moderator");
    const updateClient = jest
      .spyOn(SocketsService.prototype, "updateClient")
      .mockResolvedValue(undefined);

    await gateway.handleMessage(client);

    expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: "pong" }));
    expect(client.close).not.toHaveBeenCalled();
    expect(client.user.role).toBe("moderator");
    expect(updateClient).toHaveBeenCalled();
    updateClient.mockRestore();
  });

  it("does nothing for a socket without a user", async () => {
    const { gateway, hasura } = makeService("user");
    const client = { ...socket(), user: undefined };

    await gateway.handleMessage(client);

    expect(hasura.getPlayerRole).not.toHaveBeenCalled();
  });

  it("refuses RCON once a demoted moderator's socket has pinged", async () => {
    const { gateway } = makeService("user");
    const client = socket("moderator");
    jest
      .spyOn(SocketsService.prototype, "updateClient")
      .mockResolvedValue(undefined);
    const query = jest.fn();
    const rcon = new RconService(
      { query } as any,
      {} as any,
      {} as any,
      { warn: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await gateway.handleMessage(client);

    expect(await rcon.canAccessServer("server-1", client.user)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe("Logs stream after a demotion", () => {
  it("stops sending a running stream once the socket's role is no longer administrator", async () => {
    let stream: PassThrough;
    const loggingService = {
      getServiceLogs: jest.fn(async (_service: string, s: PassThrough) => {
        stream = s;
      }),
    };
    const gateway = new SystemGateway(
      new Logger("test"),
      loggingService as any,
    );
    const client = socket("administrator");

    await gateway.logEvent({ service: "api" }, client);

    stream.write("first line\n");
    expect(client.send).toHaveBeenCalledTimes(1);

    client.user.role = "user";
    stream.write("second line\n");

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  });

  it("refuses to start a stream for a non-administrator", async () => {
    const loggingService = { getServiceLogs: jest.fn() };
    const gateway = new SystemGateway(
      new Logger("test"),
      loggingService as any,
    );

    await gateway.logEvent({ service: "api" }, socket("moderator"));

    expect(loggingService.getServiceLogs).not.toHaveBeenCalled();
  });
});
