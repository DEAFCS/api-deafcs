import { WebsiteRestrictionsService } from "./website-restrictions.service";

describe("WebsiteRestrictionsService", () => {
  const postgres = { query: jest.fn() };
  const service = new WebsiteRestrictionsService(postgres as any);

  beforeEach(() => jest.clearAllMocks());

  it("uses server time to resolve active status and returns safe appeal fields", async () => {
    postgres.query.mockResolvedValue([
      {
        reason: "abuse",
        remove_sanction_date: "2026-09-19T10:00:00.000Z",
      },
    ]);

    await expect(service.getStatus("2")).resolves.toEqual({
      active: true,
      reason: "abuse",
      expiresAt: "2026-09-19T10:00:00.000Z",
      permanent: false,
    });
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("remove_sanction_date > now()"),
      ["2"],
    );
  });

  it("denies participation only while an active restriction exists", async () => {
    postgres.query.mockResolvedValueOnce([]);
    await expect(service.assertCanParticipate("2")).resolves.toBeUndefined();

    postgres.query.mockResolvedValueOnce([
      { reason: "abuse", remove_sanction_date: null },
    ]);
    await expect(service.assertCanParticipate("2")).rejects.toThrow(
      "restricted to read-only access",
    );
  });
});
