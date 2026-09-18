import { SanctionsService } from "./sanctions.service";

describe("SanctionsService website chat mutes", () => {
  let service: SanctionsService;
  let hasura: { mutation: jest.Mock; query: jest.Mock };
  let postgres: { query: jest.Mock; transaction: jest.Mock };
  let dedicated: { getServerPlayerList: jest.Mock };
  let rcon: { connect: jest.Mock; disconnect: jest.Mock };
  let redis: { publish: jest.Mock };

  beforeEach(() => {
    hasura = {
      mutation: jest.fn().mockResolvedValue({}),
      query: jest.fn().mockResolvedValue({ matches: [] }),
    };
    postgres = { query: jest.fn(), transaction: jest.fn() };
    dedicated = { getServerPlayerList: jest.fn() };
    rcon = {
      connect: jest.fn(),
      disconnect: jest.fn(),
    };
    redis = { publish: jest.fn().mockResolvedValue(1) };
    service = new SanctionsService(
      { warn: jest.fn() } as any,
      hasura as any,
      postgres as any,
      rcon as any,
      dedicated as any,
      { getConnection: () => redis } as any,
    );
  });

  it("creates a 24-hour mute with database time and never touches CS2", async () => {
    const expiry = "2026-09-19T10:00:00.000Z";
    postgres.query.mockResolvedValue([
      { id: "mute-1", remove_sanction_date: expiry },
    ]);

    await expect(
      service.sanctionServerPlayer({
        serverId: "crafted-server-id",
        steamId: "76561190000000002",
        type: "website_chat_mute",
        reason: " repeated spam ",
        duration: 86_400_000,
        sanctionedBySteamId: "76561190000000001",
        evidenceMessageId: "message-1",
      }),
    ).resolves.toEqual({
      id: "mute-1",
      enforced: true,
      message: "website chat mute saved and enforced",
    });

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("now() +"),
      [
        "76561190000000002",
        "76561190000000001",
        "repeated spam",
        86_400_000,
        "message-1",
      ],
    );
    expect(dedicated.getServerPlayerList).not.toHaveBeenCalled();
    expect(rcon.connect).not.toHaveBeenCalled();
    expect(redis.publish).toHaveBeenCalledWith(
      "send-message-to-steam-id",
      expect.stringContaining('"event":"chat:mute-status"'),
    );
  });

  it("requires a non-blank reason", async () => {
    await expect(
      service.sanctionServerPlayer({
        steamId: "2",
        type: "website_chat_mute",
        reason: "   ",
        duration: 900_000,
        sanctionedBySteamId: "1",
      }),
    ).rejects.toThrow("reason is required");
    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("records the revoking administrator and restores live chat access", async () => {
    postgres.query.mockResolvedValue([{ id: "mute-1" }]);

    await expect(
      service.unsanctionServerPlayer({
        steamId: "76561190000000002",
        type: "website_chat_mute",
        revokedBySteamId: "76561190000000001",
      }),
    ).resolves.toEqual({
      id: "mute-1",
      enforced: true,
      message: "website chat mute removed",
    });

    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("revoked_by_steam_id"),
      [
        "76561190000000002",
        "website_chat_mute",
        "76561190000000001",
      ],
    );
    expect(redis.publish).toHaveBeenCalledWith(
      "send-message-to-steam-id",
      expect.stringContaining('"active":false'),
    );
  });

  it("keeps active CS2 sanction projection unchanged", async () => {
    postgres.query.mockResolvedValue([
      { player_steam_id: "2", type: "mute" },
      { player_steam_id: "2", type: "gag" },
      { player_steam_id: "2", type: "website_chat_mute" },
    ]);

    await expect(service.getActiveServerSanctions("server-1")).resolves.toEqual([
      { steam_id: "2", is_banned: false, is_muted: true, is_gagged: true },
    ]);
  });

  it("creates an independent website restriction without touching CS2", async () => {
    const expiry = "2026-09-19T10:00:00.000Z";
    postgres.query.mockResolvedValue([
      { id: "restriction-1", remove_sanction_date: expiry },
    ]);

    await expect(
      service.sanctionServerPlayer({
        serverId: "crafted-server-id",
        steamId: "76561190000000002",
        type: "website_restriction",
        reason: " repeated abuse ",
        duration: 86_400_000,
        sanctionedBySteamId: "76561190000000001",
      }),
    ).resolves.toEqual({
      id: "restriction-1",
      enforced: true,
      message: "website restriction saved and enforced",
    });

    expect(dedicated.getServerPlayerList).not.toHaveBeenCalled();
    expect(rcon.connect).not.toHaveBeenCalled();
    expect(redis.publish).toHaveBeenCalledWith(
      "send-message-to-steam-id",
      expect.stringContaining('"event":"account:restriction-status"'),
    );
  });

  it("creates Ban + Website Restriction in one database transaction", async () => {
    const clientQuery = jest.fn().mockResolvedValue({
      rows: [
        { id: "ban-1", type: "ban", remove_sanction_date: null },
        {
          id: "restriction-1",
          type: "website_restriction",
          remove_sanction_date: null,
        },
      ],
    });
    postgres.transaction.mockImplementation((fn) => fn({ query: clientQuery }));

    await expect(
      service.sanctionServerPlayer({
        steamId: "76561190000000002",
        type: "ban",
        reason: "cheating",
        duration: 0,
        sanctionedBySteamId: "76561190000000001",
        alsoRestrictWebsite: true,
      }),
    ).resolves.toEqual({
      id: "ban-1",
      enforced: false,
      message: "sanction saved",
    });

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("('website_restriction'"),
      expect.any(Array),
    );
    expect(hasura.mutation).toHaveBeenCalledTimes(1); // ensurePlayer only
    expect(redis.publish).toHaveBeenCalledWith(
      "send-message-to-steam-id",
      expect.stringContaining('"permanent":true'),
    );
  });

  it("does not fall back to a lone ban when the combined transaction fails", async () => {
    postgres.transaction.mockRejectedValue(
      new Error("player already has an active website restriction"),
    );

    await expect(
      service.sanctionServerPlayer({
        steamId: "2",
        type: "ban",
        reason: "cheating",
        sanctionedBySteamId: "1",
        alsoRestrictWebsite: true,
      }),
    ).rejects.toThrow("already has an active website restriction");

    expect(hasura.mutation).toHaveBeenCalledTimes(1); // ensurePlayer only
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
