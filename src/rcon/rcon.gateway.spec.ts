import { RconGateway } from "./rcon.gateway";

describe("RconGateway website restriction enforcement", () => {
  const serverId = "server-1";
  const admin = { steam_id: "76561190000000001", name: "Admin", role: "administrator" };

  let gateway: RconGateway;
  let rconService: {
    canAccessServer: jest.Mock;
    connect: jest.Mock;
  };
  let websiteRestrictions: { getStatus: jest.Mock };

  beforeEach(() => {
    rconService = {
      canAccessServer: jest.fn().mockResolvedValue(true),
      connect: jest.fn().mockResolvedValue({ send: jest.fn().mockResolvedValue("ok") }),
    };
    websiteRestrictions = {
      getStatus: jest.fn().mockResolvedValue({ active: false }),
    };
    gateway = new RconGateway(rconService as any, websiteRestrictions as any);
  });

  it("blocks a restricted but otherwise-authorized staff member from sending RCON commands", async () => {
    websiteRestrictions.getStatus.mockResolvedValue({
      active: true,
      reason: "abuse",
      expiresAt: null,
      permanent: true,
    });
    const client = { user: { ...admin }, send: jest.fn() };

    await gateway.rconEvent(
      { uuid: "u1", command: "mp_pause_match", serverId },
      client as any,
    );

    expect(rconService.connect).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: "u1",
          result: "Your DEAFCS account is restricted to read-only access.",
        },
      }),
    );
  });

  it("allows an unrestricted, authorized staff member to send RCON commands", async () => {
    const client = { user: { ...admin }, send: jest.fn() };

    await gateway.rconEvent(
      { uuid: "u2", command: "mp_pause_match", serverId },
      client as any,
    );

    expect(rconService.connect).toHaveBeenCalledWith(serverId);
    expect(client.send).toHaveBeenCalledWith(
      expect.stringContaining('"result":"ok"'),
    );
  });

  it("never checks restriction status for a caller who cannot access the server at all", async () => {
    rconService.canAccessServer.mockResolvedValue(false);
    const client = { user: { ...admin }, send: jest.fn() };

    await gateway.rconEvent(
      { uuid: "u3", command: "mp_pause_match", serverId },
      client as any,
    );

    expect(websiteRestrictions.getStatus).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });
});
