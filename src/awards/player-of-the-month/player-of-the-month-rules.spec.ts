import {
  categoryOf,
  MonthMatch,
  monthRange,
  PLAYER_OF_THE_MONTH_RULES,
  playersToCheck,
  rankPlayerOfTheMonth,
  SanctionRow,
} from "./player-of-the-month-rules";

let seq = 0;
function match(players: [string[], string[]], over: Partial<MonthMatch> = {}): MonthMatch {
  seq++;
  return {
    id: `m${seq}`,
    type: "Competitive",
    category: "matchmaking",
    eloVoided: false,
    endedAt: `2026-10-${String((seq % 27) + 1).padStart(2, "0")}T18:00:00Z`,
    rounds: 22,
    lineup1: players[0],
    lineup2: players[1],
    withStats: [...players[0], ...players[1]],
    ...over,
  };
}
const many = (n: number, players: [string[], string[]], over: Partial<MonthMatch> = {}) =>
  Array.from({ length: n }, () => match(players, over));
const player = (steamId: string, over: any = {}) => ({
  steamId,
  name: `P${steamId}`,
  avatarUrl: null,
  country: null,
  vacBanned: false,
  vacBanCount: 0,
  gameBanCount: 0,
  ...over,
});
const sanction = (steamId: string, over: Partial<SanctionRow>): SanctionRow => ({
  steamId,
  type: "warning",
  createdAt: "2026-10-10T12:00:00Z",
  removeSanctionDate: null,
  deletedAt: null,
  reason: "test",
  system: false,
  ...over,
});
const none = { players: ["A", "B", "C", "D"].map((id) => player(id)), sanctions: [] as SanctionRow[], previousWins: [] as any[] };

describe("Player of the Month rules", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("uses UTC calendar months", () => {
    expect(monthRange("2026-10")).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
      key: "2026-10",
    });
    expect(() => monthRange("2026-13")).toThrow();
    expect(() => monthRange("26-10")).toThrow();
  });

  it("classifies matches: tournament, draft room, organizer custom, matchmaking", () => {
    expect(categoryOf({ isTournament: true, isDraft: false, hasOrganizer: true })).toBe("tournament");
    expect(categoryOf({ isTournament: false, isDraft: true, hasOrganizer: true })).toBe("draft");
    expect(categoryOf({ isTournament: false, isDraft: false, hasOrganizer: true })).toBe("custom");
    expect(categoryOf({ isTournament: false, isDraft: false, hasOrganizer: false })).toBe("matchmaking");
  });

  it("most counted matches wins; all three modes and tournaments count", () => {
    const matches = [
      ...many(3, [["A"], ["B"]], { type: "Duel" }),
      ...many(2, [["A", "C"], ["B", "D"]], { type: "Wingman" }),
      ...many(2, [["A"], ["C"]], { category: "tournament" }),
    ];
    const snap = rankPlayerOfTheMonth("2026-10", matches, none);
    expect(snap.recommendedSteamId).toBe("A");
    const a = snap.candidates[0];
    expect(a).toMatchObject({ eligibleMatches: 7, tournamentMatches: 2, byType: { Duel: 3, Wingman: 2, Competitive: 2 } });
  });

  it("draft, custom and ELO-voided matches are shown but not counted", () => {
    const matches = [
      ...many(5, [["A"], ["B"]], { category: "draft" }),
      ...many(4, [["A"], ["B"]], { category: "custom" }),
      ...many(3, [["A"], ["B"]], { eloVoided: true }),
      ...many(2, [["A"], ["B"]]),
    ];
    const a = rankPlayerOfTheMonth("2026-10", matches, none).candidates.find((c) => c.steamId === "A")!;
    expect(a.eligibleMatches).toBe(2);
    expect(a.notCounted).toEqual({ draft: 5, custom: 4, eloVoided: 3 });
  });

  it("other match types and matches outside the month are ignored", () => {
    const matches = [
      ...many(2, [["A"], ["B"]]),
      match([["B"], ["C"]], { type: "Custom" }),
      match([["B"], ["C"]], { endedAt: "2026-09-30T23:59:59Z" }),
      match([["B"], ["C"]], { endedAt: "2026-11-01T00:00:00Z" }),
    ];
    const snap = rankPlayerOfTheMonth("2026-10", matches, none);
    expect(snap.candidates.find((c) => c.steamId === "C")).toBeUndefined();
    expect(snap.candidates.find((c) => c.steamId === "B")!.eligibleMatches).toBe(2);
  });

  it("the same match is never counted twice for one player", () => {
    const m = match([["A", "A"], ["B"]]);
    const snap = rankPlayerOfTheMonth("2026-10", [m, m], none);
    expect(snap.candidates.find((c) => c.steamId === "A")!.eligibleMatches).toBe(1);
  });

  it("a ban active during the month disqualifies; a warning issued in the month disqualifies", () => {
    const matches = [...many(5, [["A"], ["B"]]), ...many(3, [["C"], ["D"]])];
    const snap = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      sanctions: [
        sanction("A", { type: "ban", createdAt: "2026-09-01T00:00:00Z", removeSanctionDate: "2026-10-05T00:00:00Z" }),
        sanction("B", { type: "warning", createdAt: "2026-10-20T00:00:00Z" }),
      ],
    });
    const a = snap.candidates.find((c) => c.steamId === "A")!;
    const b = snap.candidates.find((c) => c.steamId === "B")!;
    expect(a.eligible).toBe(false);
    expect(b.eligible).toBe(false);
    // Ineligible players above the cut are still listed with the reason.
    expect(a.disqualifiedBy[0]).toMatch(/^ban/);
    expect(snap.recommendedSteamId).toBe("C");
  });

  it("an old warning (before the month, no end date) does not disqualify; revoked bans go to review, not exclusion", () => {
    const matches = many(4, [["A"], ["B"]]);
    const snap = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      sanctions: [
        sanction("A", { type: "warning", createdAt: "2025-01-01T00:00:00Z" }),
        sanction("B", { type: "ban", createdAt: "2026-10-03T00:00:00Z", deletedAt: "2026-10-04T00:00:00Z" }),
        sanction("B", { type: "mute", createdAt: "2026-10-03T00:00:00Z" }),
      ],
    });
    const a = snap.candidates.find((c) => c.steamId === "A")!;
    const b = snap.candidates.find((c) => c.steamId === "B")!;
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(true);
    expect(b.sanctions.map((s) => s.effect).sort()).toEqual(["info", "review"]);
    expect(b.flags.some((f) => f.startsWith("removed ban"))).toBe(true);
  });

  it("Steam VAC and game bans never disqualify; they stay in the evidence", () => {
    const matches = many(3, [["A"], ["B"]]);
    const snap = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      players: [player("A", { vacBanned: true, vacBanCount: 1 }), player("B", { gameBanCount: 2 })],
    });
    const a = snap.candidates.find((c) => c.steamId === "A")!;
    const b = snap.candidates.find((c) => c.steamId === "B")!;
    expect(a.eligible).toBe(true);
    expect(a.vac).toEqual({ banned: true, vacBanCount: 1, gameBanCount: 0 });
    expect(b.eligible).toBe(true);
    expect(b.vac.gameBanCount).toBe(2);
  });

  it("only staff-issued bans and warnings disqualify; the automatic Steam VAC ban sanction is information", () => {
    const matches = [...many(5, [["A"], ["B"]]), ...many(3, [["C"], ["D"]])];
    const snap = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      sanctions: [
        // steam-bans.service.ts: type ban, no staff member.
        sanction("A", { type: "ban", system: true, createdAt: "2026-10-02T00:00:00Z", reason: "Auto: Steam VAC ban" }),
        sanction("B", { type: "ban", system: false, createdAt: "2026-10-02T00:00:00Z" }),
      ],
    });
    const a = snap.candidates.find((c) => c.steamId === "A")!;
    const b = snap.candidates.find((c) => c.steamId === "B")!;
    expect(a.eligible).toBe(true);
    expect(a.sanctions[0].effect).toBe("info");
    expect(b.eligible).toBe(false);
    expect(snap.recommendedSteamId).toBe("A");
  });

  it("only the match count decides: performance never enters the ranking", () => {
    // The ranking input has no rating/ADR/ELO/win fields at all; a player who
    // lost every match still wins on count.
    const matches = [...many(4, [["Loser"], ["W1"]]), ...many(3, [["W2"], ["X"]])];
    const snap = rankPlayerOfTheMonth("2026-10", matches, { ...none, players: [] });
    expect(snap.candidates[0]).toMatchObject({ steamId: "Loser", eligibleMatches: 4 });
  });

  it("a winner within the last 12 award months cannot win; 13 months ago can", () => {
    const matches = [...many(5, [["A"], ["B"]]), ...many(4, [["C"], ["D"]])];
    const recent = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      previousWins: [{ steamId: "A", month: "2025-10" }],
    });
    expect(recent.candidates.find((c) => c.steamId === "A")!.eligible).toBe(false);
    const old = rankPlayerOfTheMonth("2026-10", matches, {
      ...none,
      previousWins: [{ steamId: "A", month: "2025-09" }],
    });
    expect(old.candidates.find((c) => c.steamId === "A")!.eligible).toBe(true);
  });

  it("flags activity patterns without excluding anyone", () => {
    const sameDay = many(12, [["A"], ["B"]], { endedAt: "2026-10-15T20:00:00Z", rounds: 5 });
    const snap = rankPlayerOfTheMonth("2026-10", sameDay, none);
    const a = snap.candidates.find((c) => c.steamId === "A")!;
    expect(a.eligible).toBe(true);
    expect(a.indicators).toMatchObject({
      shortMatches: 12,
      busiestDay: { date: "2026-10-15", matches: 12 },
      repeatedLineupMatches: 12,
    });
    expect(a.flags.length).toBeGreaterThanOrEqual(3);
  });

  it("equal match counts are marked as a tie for staff", () => {
    const matches = [...many(3, [["A"], ["X"]], { rounds: 30 }), ...many(3, [["B"], ["Y"]], { rounds: 20 })];
    const snap = rankPlayerOfTheMonth("2026-10", matches, { ...none, players: [] });
    const [first] = snap.candidates;
    expect(first.steamId).toBe("A"); // more rounds: listed first (proposed tie-break)
    expect(first.tiedWithNext).toBe(true);
  });

  it("is deterministic (same input, same snapshot) and records the rules version", () => {
    const matches = [...many(3, [["A"], ["B"]]), ...many(3, [["C"], ["D"]])];
    const one = rankPlayerOfTheMonth("2026-10", matches, none);
    const two = rankPlayerOfTheMonth("2026-10", [...matches].reverse(), none);
    expect(two).toEqual(one);
    expect(one.rulesVersion).toBe(PLAYER_OF_THE_MONTH_RULES.version);
  });

  it("playersToCheck returns the top of the ranking", () => {
    const matches = [...many(5, [["A"], ["B"]]), ...many(2, [["C"], ["D"]])];
    expect(playersToCheck("2026-10", matches, 2)).toEqual(["A", "B"]);
  });
});
