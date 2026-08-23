import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { TermsService } from "./terms.service";

describe("TermsService", () => {
  let service: TermsService;
  let postgres: { query: jest.Mock };

  beforeEach(() => {
    postgres = { query: jest.fn() };
    service = new TermsService(postgres as any);
  });

  describe("getCurrentVersion", () => {
    it("returns the configured version", async () => {
      postgres.query.mockResolvedValueOnce([{ value: "2026-08-23" }]);
      expect(await service.getCurrentVersion()).toBe("2026-08-23");
    });

    it("returns null when no row exists", async () => {
      postgres.query.mockResolvedValueOnce([]);
      expect(await service.getCurrentVersion()).toBeNull();
    });

    it("returns null (not the empty string) for a blank value", async () => {
      postgres.query.mockResolvedValueOnce([{ value: "" }]);
      expect(await service.getCurrentVersion()).toBeNull();
    });
  });

  describe("hasAcceptedCurrentTerms", () => {
    it("is false, without even checking acceptances, when no version is configured", async () => {
      postgres.query.mockResolvedValueOnce([]);
      expect(await service.hasAcceptedCurrentTerms("1")).toBe(false);
      expect(postgres.query).toHaveBeenCalledTimes(1);
    });

    it("is true when an acceptance row exists for the current version", async () => {
      postgres.query
        .mockResolvedValueOnce([{ value: "2026-08-23" }])
        .mockResolvedValueOnce([{ accepted: true }]);
      expect(await service.hasAcceptedCurrentTerms("1")).toBe(true);
    });

    it("is false when no acceptance row exists for the current version", async () => {
      postgres.query
        .mockResolvedValueOnce([{ value: "2026-08-23" }])
        .mockResolvedValueOnce([{ accepted: false }]);
      expect(await service.hasAcceptedCurrentTerms("1")).toBe(false);
    });
  });

  describe("assertAccepted", () => {
    it("resolves silently when the player has accepted", async () => {
      postgres.query
        .mockResolvedValueOnce([{ value: "2026-08-23" }])
        .mockResolvedValueOnce([{ accepted: true }]);
      await expect(service.assertAccepted("1")).resolves.toBeUndefined();
    });

    it("throws ForbiddenException when the player has not accepted", async () => {
      postgres.query
        .mockResolvedValueOnce([{ value: "2026-08-23" }])
        .mockResolvedValueOnce([{ accepted: false }]);
      await expect(service.assertAccepted("1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws ForbiddenException (fails closed) when no version is configured", async () => {
      postgres.query.mockResolvedValueOnce([]);
      await expect(service.assertAccepted("1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("acceptCurrentTerms", () => {
    it("inserts an acceptance row for the current version and returns it", async () => {
      postgres.query
        .mockResolvedValueOnce([{ value: "2026-08-23" }])
        .mockResolvedValueOnce(undefined);
      const result = await service.acceptCurrentTerms("1");
      expect(result).toEqual({ terms_version: "2026-08-23" });
      expect(postgres.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("ON CONFLICT (player_steam_id, terms_version) DO NOTHING"),
        ["1", "2026-08-23"],
      );
    });

    it("throws BadRequestException (fails closed) when no version is configured", async () => {
      postgres.query.mockResolvedValueOnce([]);
      await expect(service.acceptCurrentTerms("1")).rejects.toThrow(
        BadRequestException,
      );
      expect(postgres.query).toHaveBeenCalledTimes(1);
    });
  });
});
