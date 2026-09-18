import { WebsiteRestrictionGuard } from "./website-restrictions.guard";

describe("WebsiteRestrictionGuard", () => {
  const restrictions = { assertCanParticipate: jest.fn() };
  const guard = new WebsiteRestrictionGuard(restrictions as any);

  function context(request: Record<string, unknown>) {
    return {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    restrictions.assertCanParticipate.mockResolvedValue(undefined);
  });

  it("checks the authenticated actor on mutating REST requests", async () => {
    await expect(
      guard.canActivate(
        context({
          method: "POST",
          body: {},
          user: { steam_id: "76561190000000002", role: "verified_user" },
        }),
      ),
    ).resolves.toBe(true);

    expect(restrictions.assertCanParticipate).toHaveBeenCalledWith(
      "76561190000000002",
    );
  });

  it("allows reads and essential account actions", async () => {
    await guard.canActivate(
      context({ method: "GET", body: {}, user: { steam_id: "2" } }),
    );
    await guard.canActivate(
      context({
        method: "POST",
        body: { action: { name: "websiteRestrictionStatus" } },
        user: { steam_id: "2" },
      }),
    );
    await guard.canActivate(
      context({
        method: "POST",
        body: { action: { name: "logout" } },
        user: { steam_id: "2" },
      }),
    );

    expect(restrictions.assertCanParticipate).not.toHaveBeenCalled();
  });

  it("propagates the read-only denial for custom mutations", async () => {
    restrictions.assertCanParticipate.mockRejectedValue(
      new Error("restricted to read-only access"),
    );

    await expect(
      guard.canActivate(
        context({
          method: "POST",
          body: { action: { name: "createDraftGame" } },
          user: { steam_id: "2" },
        }),
      ),
    ).rejects.toThrow("restricted to read-only access");
  });
});
