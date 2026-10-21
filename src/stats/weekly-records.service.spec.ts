import { BadRequestException } from "@nestjs/common";
import { StatsController } from "./stats.controller";
import { WeeklyRecordsService } from "./weekly-records.service";

class FakeCache {
  public store = new Map<string, any>();
  async get(key: string) {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  async put(key: string, value: any) {
    this.store.set(key, JSON.stringify(value));
    return true;
  }
  async acquireLock() {
    return "token";
  }
  async releaseLock() {
    return true;
  }
}

const M5 = "11111111-1111-4111-8111-111111111111"; // 5v5
const M4 = "22222222-2222-4222-8222-222222222222"; // 4v5 (short-handed)

describe("WeeklyRecordsService", () => {
  let postgres: { query: jest.Mock };
  let cache: FakeCache;
  let service: WeeklyRecordsService;
  let clutchParams: any[] | null;

  beforeEach(() => {
    clutchParams = null;
    postgres = {
      query: jest.fn(async (sql: string, params: any[]) => {
        if (sql.includes("FROM public.matches m")) {
          // Same filters as the browser's Hasura query.
          expect(sql).toContain("m.status = 'Finished'");
          expect(sql).toContain("m.source = '5stack'");
          expect(params[1]).toBe("Competitive");
          return [
            { id: M5, mr: 12, seated_1: 5, seated_2: 5 },
            { id: M4, mr: 12, seated_1: 4, seated_2: 5 },
          ];
        }
        if (sql.includes("v_player_match_rating")) {
          return [
            { steam_id: "1", match_id: M5, adr: "90.0", hltv_rating: "1.20", rounds_played: 24 },
            { steam_id: "2", match_id: M5, adr: "70.0", hltv_rating: "0.90", rounds_played: 24 },
          ];
        }
        if (sql.includes("player_match_stats_v")) {
          return [
            { steam_id: "1", match_id: M5, kills: 25, hs_kills: 10, deaths: 14 },
            { steam_id: "2", match_id: M5, kills: 15, hs_kills: 5, deaths: 18 },
          ];
        }
        if (sql.includes("v_match_clutches")) {
          clutchParams = params;
          return [{ match_id: M5, clutcher_steam_id: "1" }];
        }
        if (sql.includes("v_match_player_opening_duels")) {
          return [{ match_id: M5, steam_id: "2", wins: 6 }];
        }
        if (sql.includes("FROM public.players")) {
          return params[0].map((id: string) => ({ steam_id: id, name: `P${id}`, avatar_url: null as string | null, country: "DK" }));
        }
        throw new Error(`unexpected sql ${sql}`);
      }),
    };
    cache = new FakeCache();
    service = new WeeklyRecordsService(postgres as any, cache as any, { warn: jest.fn() } as any);
  });

  it("computes all records with names, and only counts clutches in 5v5 matches", async () => {
    const result = await service.get("Competitive");
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.matchCount).toBe(2);
    expect(clutchParams?.[0]).toEqual([M5]);
    expect(result.records.find((r) => r.key === "clutches")?.entries[0]).toMatchObject({ steamId: "1", value: 1 });
    expect(result.records.find((r) => r.key === "opening_kills")?.entries[0]).toMatchObject({ steamId: "2", value: 6 });
    expect(result.records.find((r) => r.key === "match_kills")?.entries[0]).toMatchObject({ steamId: "1", matchId: M5 });
    expect(result.players["1"]).toEqual({ name: "P1", avatar_url: null, country: "DK" });
    expect(result.generatedAt).toEqual(expect.any(String));
  });

  it("a second request is served from the shared cache (no SQL)", async () => {
    await service.get("Competitive");
    const calls = postgres.query.mock.calls.length;
    await service.get("Competitive");
    expect(postgres.query.mock.calls.length).toBe(calls);
  });

  it("no matches in the window: empty records, no further queries", async () => {
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.matches m")) return [];
      throw new Error("should not query");
    });
    const result = await service.get("Competitive");
    expect(result).toMatchObject({ available: true, matchCount: 0, records: [] });
  });

  it("cold cache while another pod computes: unavailable instead of a second computation", async () => {
    (cache as any).acquireLock = async (): Promise<string | null> => null;
    (WeeklyRecordsService as any).COLD_WAIT_MS = 30;
    try {
      const result = await service.get("Competitive");
      expect(result).toEqual({ available: false, mode: "Competitive" });
      expect(postgres.query).not.toHaveBeenCalled();
    } finally {
      (WeeklyRecordsService as any).COLD_WAIT_MS = 8_000;
    }
  });
});

describe("StatsController", () => {
  it("defaults to Competitive and refuses other modes for now", async () => {
    const weekly = { get: jest.fn().mockResolvedValue({ available: false, mode: "Competitive" }) };
    const controller = new StatsController(weekly as any);
    await controller.getWeeklyRecords();
    expect(weekly.get).toHaveBeenCalledWith("Competitive");
    await expect(controller.getWeeklyRecords("Wingman")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getWeeklyRecords("x' OR 1=1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
