import { e_match_types_enum } from "generated";
import {
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingQueueCacheKey,
  getMatchmakingRankCacheKey,
  getMatchmakingRegionLockKey,
} from "./cacheKeys";
import {
  getMatchmakingRegionStatsKey,
  isQueueVariantAllowedForType,
  MatchmakingQueueVariant,
  resolveMatchmakingQueueVariant,
} from "../types/MatchmakingQueueVariant";

const types: e_match_types_enum[] = ["Duel", "Wingman", "Competitive"];

describe("matchmaking queue variants", () => {
  it("resolves a missing variant to Standard", () => {
    expect(resolveMatchmakingQueueVariant(undefined)).toBe("Standard");
    expect(resolveMatchmakingQueueVariant(null)).toBe("Standard");
  });

  it("resolves explicit known variants to themselves", () => {
    expect(resolveMatchmakingQueueVariant("Standard")).toBe("Standard");
    expect(resolveMatchmakingQueueVariant("CaptainPick")).toBe("CaptainPick");
  });

  it("rejects unknown variants instead of treating them as Standard", () => {
    for (const value of ["", "captainpick", "Captain Pick", "Draft", 1, {}]) {
      expect(resolveMatchmakingQueueVariant(value)).toBeUndefined();
    }
  });

  it("only allows CaptainPick for Competitive", () => {
    expect(isQueueVariantAllowedForType("Competitive", "CaptainPick")).toBe(
      true,
    );
    for (const type of ["Wingman", "Duel", "Premier", "Faceit"] as const) {
      expect(isQueueVariantAllowedForType(type, "CaptainPick")).toBe(false);
      expect(isQueueVariantAllowedForType(type, "Standard")).toBe(true);
    }
  });

  it("keeps Standard region-stats keys as the bare match type", () => {
    for (const type of types) {
      expect(getMatchmakingRegionStatsKey(type)).toBe(type);
      expect(getMatchmakingRegionStatsKey(type, "Standard")).toBe(type);
    }
    expect(getMatchmakingRegionStatsKey("Competitive", "CaptainPick")).toBe(
      "CompetitiveCaptainPick",
    );
  });
});

describe("matchmaking cache keys", () => {
  // Exact keys live queues use today. Changing any of these strands every
  // lobby already queued in Redis.
  it("keeps Standard keys exactly as before", () => {
    expect(getMatchmakingQueueCacheKey("Competitive", "Europe")).toBe(
      "matchmaking:v20:Europe:Competitive",
    );
    expect(getMatchmakingRankCacheKey("Competitive", "Europe")).toBe(
      "matchmaking:v20:Europe:Competitive:ranks",
    );
    expect(getMatchmakingQueueCacheKey("Wingman", "Europe")).toBe(
      "matchmaking:v20:Europe:Wingman",
    );
    expect(getMatchmakingRankCacheKey("Duel", "Europe")).toBe(
      "matchmaking:v20:Europe:Duel:ranks",
    );
    expect(getMatchmakingLobbyDetailsCacheKey("lobby-1")).toBe(
      "matchmaking:v20:details:lobby-1",
    );
    expect(getMatchmakingConformationCacheKey("conf-1")).toBe(
      "matchmaking:v20:conf-1",
    );
  });

  it("gives explicit Standard the same keys as no variant", () => {
    for (const type of types) {
      expect(getMatchmakingQueueCacheKey(type, "Europe", "Standard")).toBe(
        getMatchmakingQueueCacheKey(type, "Europe"),
      );
      expect(getMatchmakingRankCacheKey(type, "Europe", "Standard")).toBe(
        getMatchmakingRankCacheKey(type, "Europe"),
      );
    }
  });

  it("gives Captain Pick its own queue and rank keys", () => {
    expect(
      getMatchmakingQueueCacheKey("Competitive", "Europe", "CaptainPick"),
    ).toBe("matchmaking:v20:Europe:Competitive:captain-pick");
    expect(
      getMatchmakingRankCacheKey("Competitive", "Europe", "CaptainPick"),
    ).toBe("matchmaking:v20:Europe:Competitive:captain-pick:ranks");
  });

  it("never lets any queue or rank key collide across variants, regions or kinds", () => {
    const keys: string[] = [];
    const combos: Array<[e_match_types_enum, MatchmakingQueueVariant]> = [
      ...types.map(
        (type) => [type, "Standard"] as [e_match_types_enum, "Standard"],
      ),
      ["Competitive", "CaptainPick"],
    ];

    for (const region of ["Europe", "US East", "Europe:Competitive"]) {
      for (const [type, variant] of combos) {
        keys.push(getMatchmakingQueueCacheKey(type, region, variant));
        keys.push(getMatchmakingRankCacheKey(type, region, variant));
      }
    }

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses Captain Pick keys for non-Competitive types", () => {
    for (const type of ["Wingman", "Duel", "Premier", "Faceit"] as const) {
      expect(() =>
        getMatchmakingQueueCacheKey(type, "Europe", "CaptainPick"),
      ).toThrow();
      expect(() =>
        getMatchmakingRankCacheKey(type, "Europe", "CaptainPick"),
      ).toThrow();
    }
  });

  it("refuses unknown variants rather than falling back to Standard keys", () => {
    expect(() =>
      getMatchmakingQueueCacheKey("Competitive", "Europe", "Draft" as any),
    ).toThrow();
  });

  it("keeps the Standard region lock exactly as before", () => {
    expect(getMatchmakingRegionLockKey("Europe")).toBe(
      "matchmaking:lock:Europe",
    );
    expect(getMatchmakingRegionLockKey("Europe", "Standard")).toBe(
      "matchmaking:lock:Europe",
    );
  });

  it("gives Captain Pick a separate region lock", () => {
    expect(getMatchmakingRegionLockKey("Europe", "CaptainPick")).toBe(
      "matchmaking:lock:Europe:captain-pick",
    );
    expect(getMatchmakingRegionLockKey("Europe", "CaptainPick")).not.toBe(
      getMatchmakingRegionLockKey("Europe"),
    );
  });
});
