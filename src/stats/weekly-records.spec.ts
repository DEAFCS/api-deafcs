import {
  HS_MIN_KILLS,
  RATE_MIN_MATCHES,
  RATE_MIN_ROUNDS,
  RECORD_ORDER,
  SINGLE_MATCH_MIN_ROUNDS,
  weeklyRecords,
} from "./weekly-records";

// Same cases as the WEB test (deafcs-web test/home-dashboard.test.mjs), so
// both copies of the calculation are held to the same rules.

function rows(
  steamId: string,
  matches: number,
  { rounds = 24, adr = 80, rating = 1, kills = 18, hs = 9, deaths = 15 } = {},
) {
  const ratings: any[] = [];
  const stats: any[] = [];
  for (let i = 0; i < matches; i++) {
    const match_id = `${steamId}-m${i}`;
    ratings.push({ steam_id: steamId, match_id, adr, hltv_rating: rating, rounds_played: rounds });
    stats.push({ steam_id: steamId, match_id, kills, hs_kills: hs, deaths });
  }
  return { ratings, stats };
}
const merge = (...parts: Array<{ ratings: any[]; stats: any[] }>) => ({
  ratings: parts.flatMap((p) => p.ratings),
  stats: parts.flatMap((p) => p.stats),
});
const record = (records: any[], key: string) => records.find((r) => r.key === key);

describe("weeklyRecords (shared with the WEB)", () => {
  it("rate records ignore players below the match minimum", () => {
    const { ratings, stats } = merge(
      rows("1", RATE_MIN_MATCHES - 1, { adr: 200, rating: 2.5 }),
      rows("2", RATE_MIN_MATCHES, { adr: 90, rating: 1.2 }),
    );
    const records = weeklyRecords(ratings, stats, {});
    expect(record(records, "adr").entries[0].steamId).toBe("2");
    expect(record(records, "rating").entries[0].steamId).toBe("2");
    expect(record(records, "kills").entries.some((e: any) => e.steamId === "1")).toBe(true);
  });

  it("rate records need the minimum rounds", () => {
    const p = rows("1", RATE_MIN_MATCHES, {
      rounds: Math.floor((RATE_MIN_ROUNDS - 1) / RATE_MIN_MATCHES),
      adr: 150,
    });
    expect(record(weeklyRecords(p.ratings, p.stats, {}), "adr")).toBeUndefined();
  });

  it("ADR and rating are averaged by rounds", () => {
    const p = rows("1", 2, { rounds: 30, adr: 100, rating: 1.5 });
    const q = rows("1", 1, { rounds: 10, adr: 40, rating: 0.5 });
    q.ratings[0].match_id = q.stats[0].match_id = "1-extra";
    const { ratings, stats } = merge(p, q);
    const records = weeklyRecords(ratings, stats, {});
    expect(record(records, "adr").entries[0].display).toBe("91.4");
    expect(record(records, "rating").entries[0].display).toBe("1.36");
  });

  it("headshot % needs the kill minimum", () => {
    const { ratings, stats } = merge(
      rows("1", RATE_MIN_MATCHES, { kills: Math.floor((HS_MIN_KILLS - 1) / RATE_MIN_MATCHES), hs: 9 }),
      rows("2", RATE_MIN_MATCHES, { kills: 20, hs: 10 }),
    );
    const entries = record(weeklyRecords(ratings, stats, {}), "hs").entries;
    expect(entries.map((e: any) => e.steamId)).toEqual(["2"]);
    expect(entries[0].display).toBe("50%");
  });

  it("most kills in one match: regulation only, the match's own rounds decide", () => {
    const { ratings, stats } = merge(rows("1", 1, { rounds: 30, kills: 40 }), rows("2", 1, { rounds: 24, kills: 30 }));
    const entries = record(weeklyRecords(ratings, stats, { "1-m0": 12, "2-m0": 12 }), "match_kills").entries;
    expect(entries.map((e: any) => e.matchId)).toEqual(["2-m0"]);
  });

  it("top five with competition ranking and deterministic order", () => {
    const players = ["1", "2", "3", "4", "5", "6"].map((id, i) => rows(id, 1, { kills: 10 + i }));
    const { ratings, stats } = merge(...players);
    const kills = record(weeklyRecords(ratings, stats, {}), "kills").entries;
    expect(kills.map((e: any) => e.steamId)).toEqual(["6", "5", "4", "3", "2"]);

    const tied = merge(...["3", "1", "2", "4"].map((id) => rows(id, 1, { kills: id === "4" ? 5 : 20 })));
    const tiedEntries = record(weeklyRecords(tied.ratings, tied.stats, {}), "kills").entries;
    expect(tiedEntries.map((e: any) => [e.steamId, e.place])).toEqual([
      ["1", 1],
      ["2", 1],
      ["3", 1],
      ["4", 4],
    ]);
  });

  it("lowest DPR is total deaths / total rounds", () => {
    const a = rows("1", 2, { rounds: 24, deaths: 15 });
    const b = rows("1", 1, { rounds: 10, deaths: 0 });
    b.ratings[0].match_id = b.stats[0].match_id = "1-extra";
    const { ratings, stats } = merge(a, b, rows("2", 3, { rounds: 24, deaths: 20 }));
    const entries = record(weeklyRecords(ratings, stats, {}), "dpr").entries;
    expect(entries.map((e: any) => e.steamId)).toEqual(["1", "2"]);
    expect(entries[0].display).toBe("0.52");
  });

  it("single-match records need 10 rounds and keep the match id (scoreboard link)", () => {
    const { ratings, stats } = merge(
      rows("1", 1, { rounds: SINGLE_MATCH_MIN_ROUNDS - 1, rating: 3, adr: 200, kills: 15 }),
      rows("2", 1, { rounds: 20, rating: 1.4, adr: 95, kills: 22 }),
    );
    const records = weeklyRecords(ratings, stats, {});
    for (const key of ["match_rating", "match_adr", "match_kills"]) {
      expect(record(records, key).entries.map((e: any) => [e.steamId, e.matchId])).toEqual([["2", "2-m0"]]);
    }
  });

  it("clutches and opening kills appear only with their data, in the agreed order", () => {
    const p = merge(rows("1", 3), rows("2", 3));
    expect(record(weeklyRecords(p.ratings, p.stats, {}), "clutches")).toBeUndefined();
    const all = weeklyRecords(p.ratings, p.stats, {}, {
      clutches: [{ match_id: "1-m0", clutcher_steam_id: "1" }],
      openings: [{ match_id: "1-m0", steam_id: "2", wins: 4 }],
    });
    expect(all.map((r) => r.key)).toEqual(RECORD_ORDER);
    for (const r of all) expect(r.rule.length).toBeGreaterThan(0);
  });
});
