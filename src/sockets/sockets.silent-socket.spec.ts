import { SocketsService } from "./sockets.service";
import { SocketsGateway } from "./sockets.gateway";

// Ported from 5stackgg/api ba90c28 (its pod tick). The role is refreshed on
// each ping, so a socket that never pings (a script holding a staff member's
// old socket open) kept the role it was opened with, for RCON, the Logs
// stream and every other socket handler. Silent sockets are now closed.

const STEAM_ID = "76561198000000001";

function makeService(role = "user") {
  const redis = { set: jest.fn().mockResolvedValue("OK") };
  const hasura = { getPlayerRole: jest.fn().mockResolvedValue(role) };
  const service = new SocketsService(
    { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as any,
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
  return { service, gateway: new SocketsGateway(service, {} as any) };
}

function socket(id: string, lastSeenAt: number) {
  return {
    id,
    user: { steam_id: STEAM_ID, name: "Staff", role: "administrator" },
    lastSeenAt,
    send: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
  } as any;
}

describe("silent web sockets", () => {
  const NOW = 1_800_000_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("closes a socket that has not pinged for 150 seconds", () => {
    const { service } = makeService();
    const silent = socket("silent", NOW - 151 * 1000);
    const live = socket("live", NOW - 15 * 1000);
    (service as any).clients.set(silent.id, silent);
    (service as any).clients.set(live.id, live);

    service.closeSilentSockets();

    expect(silent.terminate).toHaveBeenCalled();
    expect(live.terminate).not.toHaveBeenCalled();
  });

  it("keeps a backgrounded tab that pings once a minute", () => {
    const { service } = makeService();
    const throttled = socket("throttled", NOW - 60 * 1000);
    (service as any).clients.set(throttled.id, throttled);

    service.closeSilentSockets();

    expect(throttled.terminate).not.toHaveBeenCalled();
  });

  it("counts a ping as a sign of life", async () => {
    const { service, gateway } = makeService();
    jest.spyOn(service, "updateClient").mockResolvedValue(undefined);
    const client = socket("client", NOW - 149 * 1000);
    (service as any).clients.set(client.id, client);

    await gateway.handleMessage(client);
    jest.setSystemTime(NOW + 100 * 1000);
    service.closeSilentSockets();

    expect(client.lastSeenAt).toBe(NOW);
    expect(client.terminate).not.toHaveBeenCalled();
  });

  it("checks every 10 seconds once the module starts", () => {
    const { service } = makeService();
    const check = jest
      .spyOn(service, "closeSilentSockets")
      .mockImplementation(() => undefined);

    service.onModuleInit();
    jest.advanceTimersByTime(30 * 1000);
    service.onApplicationShutdown();
    jest.advanceTimersByTime(30 * 1000);

    expect(check).toHaveBeenCalledTimes(3);
  });
});
