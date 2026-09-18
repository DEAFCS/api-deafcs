import { SanctionsController } from "./sanctions.controller";

describe("SanctionsController website chat authorization", () => {
  const service = {
    sanctionServerPlayer: jest.fn().mockResolvedValue({ id: "id" }),
    unsanctionServerPlayer: jest.fn().mockResolvedValue({ id: "id" }),
  };
  const websiteRestrictions = { getStatus: jest.fn() };
  const controller = new SanctionsController(
    service as any,
    websiteRestrictions as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it("allows only site administrators to issue website chat mutes", async () => {
    await expect(
      controller.sanctionServerPlayer({
        steam_id: "2",
        type: "website_chat_mute",
        reason: "spam",
        duration: 86_400_000,
        user: { steam_id: "1", role: "moderator" } as any,
      }),
    ).rejects.toThrow("not allowed");

    await expect(
      controller.sanctionServerPlayer({
        steam_id: "2",
        type: "website_chat_mute",
        reason: "spam",
        duration: 86_400_000,
        evidence_message_id: "message-1",
        user: { steam_id: "1", role: "administrator" } as any,
      }),
    ).resolves.toEqual({ id: "id" });

    expect(service.sanctionServerPlayer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "website_chat_mute",
        sanctionedBySteamId: "1",
        evidenceMessageId: "message-1",
      }),
    );
  });

  it("allows only site administrators to revoke website chat mutes", async () => {
    await expect(
      controller.unsanctionServerPlayer({
        steam_id: "2",
        type: "website_chat_mute",
        user: { steam_id: "1", role: "moderator" } as any,
      }),
    ).rejects.toThrow("not allowed");

    await controller.unsanctionServerPlayer({
      steam_id: "2",
      type: "website_chat_mute",
      user: { steam_id: "1", role: "administrator" } as any,
    });
    expect(service.unsanctionServerPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ revokedBySteamId: "1" }),
    );
  });

  it("keeps the existing moderator authorization for CS2 sanctions", async () => {
    await expect(
      controller.sanctionServerPlayer({
        steam_id: "2",
        type: "gag",
        reason: "game chat",
        user: { steam_id: "1", role: "moderator" } as any,
      }),
    ).resolves.toEqual({ id: "id" });
  });

  it("allows only site administrators to issue or combine website restrictions", async () => {
    for (const role of ["user", "moderator", "match_organizer"] as const) {
      await expect(
        controller.sanctionServerPlayer({
          steam_id: "2",
          type: "website_restriction",
          reason: "abuse",
          user: { steam_id: "1", role } as any,
        }),
      ).rejects.toThrow("not allowed");

      await expect(
        controller.sanctionServerPlayer({
          steam_id: "2",
          type: "ban",
          reason: "abuse",
          also_restrict_website: true,
          user: { steam_id: "1", role } as any,
        }),
      ).rejects.toThrow("not allowed");
    }

    await expect(
      controller.sanctionServerPlayer({
        steam_id: "2",
        type: "ban",
        reason: "abuse",
        also_restrict_website: true,
        user: { steam_id: "1", role: "administrator" } as any,
      }),
    ).resolves.toEqual({ id: "id" });

    expect(service.sanctionServerPlayer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "ban",
        alsoRestrictWebsite: true,
        sanctionedBySteamId: "1",
      }),
    );
  });

  it("requires an administrator to revoke a website restriction", async () => {
    await expect(
      controller.unsanctionServerPlayer({
        steam_id: "2",
        type: "website_restriction",
        user: { steam_id: "1", role: "match_organizer" } as any,
      }),
    ).rejects.toThrow("not allowed");

    await expect(
      controller.unsanctionServerPlayer({
        steam_id: "2",
        type: "website_restriction",
        user: { steam_id: "1", role: "administrator" } as any,
      }),
    ).resolves.toEqual({ id: "id" });
  });
});
