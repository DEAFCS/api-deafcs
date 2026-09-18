import { BlocksService } from "./blocks.service";

describe("BlocksService", () => {
  let service: BlocksService;
  let postgres: { query: jest.Mock };

  beforeEach(() => {
    postgres = { query: jest.fn() };
    service = new BlocksService(postgres as any);
  });

  describe("isBlockedEitherDirection", () => {
    it("returns false without querying when the steam ids are identical", async () => {
      await expect(
        service.isBlockedEitherDirection("1", "1"),
      ).resolves.toBe(false);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("returns true when a block exists in either direction", async () => {
      postgres.query.mockResolvedValue([{ exists: true }]);
      await expect(
        service.isBlockedEitherDirection("1", "2"),
      ).resolves.toBe(true);
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("blocker_steam_id = $1"),
        ["1", "2"],
      );
    });

    it("returns false when no block exists", async () => {
      postgres.query.mockResolvedValue([{ exists: false }]);
      await expect(
        service.isBlockedEitherDirection("1", "2"),
      ).resolves.toBe(false);
    });
  });

  describe("hasBlocked (directional)", () => {
    it("returns false without querying for identical steam ids", async () => {
      await expect(service.hasBlocked("1", "1")).resolves.toBe(false);
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("only reports true for the specific blocker -> blocked direction", async () => {
      postgres.query.mockResolvedValue([{ exists: true }]);
      await expect(service.hasBlocked("1", "2")).resolves.toBe(true);
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining(
          "blocker_steam_id = $1::bigint AND blocked_steam_id = $2::bigint",
        ),
        ["1", "2"],
      );
    });
  });

  describe("getViewersBlocking", () => {
    it("returns the empty set without querying when there are no candidates left", async () => {
      await expect(
        service.getViewersBlocking(["5"], "5"),
      ).resolves.toEqual(new Set());
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("excludes the sender itself from the candidate list, even if passed in", async () => {
      postgres.query.mockResolvedValue([{ blocker_steam_id: "2" }]);
      const result = await service.getViewersBlocking(["2", "5"], "5");
      expect(result).toEqual(new Set(["2"]));
      const [, params] = postgres.query.mock.calls[0];
      expect(params[1]).toEqual(["2"]);
    });

    it("dedupes candidates", async () => {
      postgres.query.mockResolvedValue([]);
      await service.getViewersBlocking(["2", "2", "3"], "5");
      const [, params] = postgres.query.mock.calls[0];
      expect(params[1]).toEqual(["2", "3"]);
    });
  });

  describe("getMyBlockedSteamIds", () => {
    it("returns the set of steam ids this player has blocked", async () => {
      postgres.query.mockResolvedValue([
        { blocked_steam_id: "10" },
        { blocked_steam_id: "11" },
      ]);
      await expect(service.getMyBlockedSteamIds("1")).resolves.toEqual(
        new Set(["10", "11"]),
      );
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("blocker_steam_id = $1"),
        ["1"],
      );
    });
  });
});
