import {
  applyCaptainAutoPick,
  applyCaptainPick,
  buildCaptainPickPattern,
  CAPTAIN_PICK_PLAYER_COUNT,
  CAPTAIN_PICK_TEAM_SIZE,
  CaptainPickParticipant,
  CaptainPickRuleError,
  compareCaptainPickPriority,
  createCaptainPickDraft,
  determineFirstPick,
  getManualPickOrder,
  getPickingLineup,
  resolveLastPlayerLineup,
  selectAutoPick,
  selectCaptains,
} from "./captain-pick-rules";

const base = new Date("2026-09-29T12:00:00.000Z").getTime();

const player = (
  steam_id: string,
  elo: number,
  joinedSecondsAfterBase = 0,
): CaptainPickParticipant => ({
  steam_id,
  elo,
  joinedAt: new Date(base + joinedSecondsAfterBase * 1000).toISOString(),
});

// Ten players with distinct ELO, deliberately not in ELO order.
const tenPlayers = () => [
  player("76561198000000003", 9000, 3),
  player("76561198000000001", 12500, 1),
  player("76561198000000007", 6000, 7),
  player("76561198000000002", 11900, 2),
  player("76561198000000005", 8000, 5),
  player("76561198000000010", 3000, 10),
  player("76561198000000004", 8500, 4),
  player("76561198000000009", 4000, 9),
  player("76561198000000006", 7000, 6),
  player("76561198000000008", 5000, 8),
];

describe("Captain Pick rules", () => {
  describe("selectCaptains", () => {
    it("selects the two highest-ELO players", () => {
      const { captains, pool } = selectCaptains(tenPlayers());

      expect(captains.map((c) => c.steam_id)).toEqual([
        "76561198000000001",
        "76561198000000002",
      ]);
      expect(pool).toHaveLength(8);
      expect(pool.map((p) => p.steam_id)).not.toContain("76561198000000001");
      expect(pool.map((p) => p.steam_id)).not.toContain("76561198000000002");
    });

    it("breaks a tie for captaincy by earlier queue time", () => {
      const players = tenPlayers();
      // Third-highest now ties the second captain but queued earlier.
      players[0] = player("76561198000000003", 11900, 0);

      const { captains } = selectCaptains(players);

      expect(captains.map((c) => c.steam_id)).toEqual([
        "76561198000000001",
        "76561198000000003",
      ]);
    });

    it("breaks a full tie by steam ID, numerically", () => {
      const players = tenPlayers();
      players[0] = player("76561198000000100", 11900, 2);
      players[3] = player("76561198000000099", 11900, 2);

      const { captains } = selectCaptains(players);

      expect(captains[1].steam_id).toBe("76561198000000099");
    });

    it("does not depend on input order", () => {
      const players = tenPlayers();
      const reversed = [...players].reverse();

      expect(selectCaptains(players).captains).toEqual(
        selectCaptains(reversed).captains,
      );
      expect(selectCaptains(players).pool).toEqual(
        selectCaptains(reversed).pool,
      );
    });

    it("requires exactly ten players", () => {
      expect(() => selectCaptains(tenPlayers().slice(0, 9))).toThrow(
        CaptainPickRuleError,
      );
      expect(() =>
        selectCaptains([...tenPlayers(), player("76561198000000011", 1)]),
      ).toThrow(CaptainPickRuleError);
    });

    it("rejects duplicate players and invalid data", () => {
      const duplicate = tenPlayers();
      duplicate[9] = { ...duplicate[0] };
      expect(() => selectCaptains(duplicate)).toThrow(/more than once/);

      const badElo = tenPlayers();
      badElo[0] = { ...badElo[0], elo: Number.NaN };
      expect(() => selectCaptains(badElo)).toThrow(/invalid elo/);

      const badTime = tenPlayers();
      badTime[0] = { ...badTime[0], joinedAt: "not a date" };
      expect(() => selectCaptains(badTime)).toThrow(/invalid queue time/);
    });
  });

  describe("determineFirstPick", () => {
    it("lets the lower-ELO captain pick first", () => {
      const a = player("76561198000000001", 12500);
      const b = player("76561198000000002", 11900);

      const result = determineFirstPick([a, b]);

      expect(result.firstPicker).toBe(b);
      expect(result.secondPicker).toBe(a);
      expect(result.reason).toBe("LowerElo");
    });

    it("ignores the coin flip when ELO differs", () => {
      const a = player("76561198000000001", 12500);
      const b = player("76561198000000002", 11900);

      expect(determineFirstPick([a, b], 0).firstPicker).toBe(b);
      expect(determineFirstPick([a, b], 1).firstPicker).toBe(b);
    });

    it("uses the injected server coin flip for exactly equal ELO", () => {
      const a = player("76561198000000001", 10000);
      const b = player("76561198000000002", 10000);

      expect(determineFirstPick([a, b], 0)).toEqual({
        firstPicker: a,
        secondPicker: b,
        reason: "EqualEloCoinFlip",
      });
      expect(determineFirstPick([a, b], 1)).toEqual({
        firstPicker: b,
        secondPicker: a,
        reason: "EqualEloCoinFlip",
      });
    });

    it("refuses to guess when equal ELO has no coin flip", () => {
      const a = player("76561198000000001", 10000);
      const b = player("76561198000000002", 10000);

      expect(() => determineFirstPick([a, b])).toThrow(/coin flip/);
      expect(() => determineFirstPick([a, b], 2 as any)).toThrow(/coin flip/);
    });
  });

  describe("pick order", () => {
    it("is strictly alternating, lower captain (lineup 1) first", () => {
      expect(buildCaptainPickPattern(10)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
      expect(buildCaptainPickPattern()).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    });

    it("never gives the same captain two picks in a row", () => {
      for (const count of [4, 6, 8, 10, 12]) {
        const pattern = buildCaptainPickPattern(count);
        for (let i = 1; i < pattern.length; i++) {
          expect(pattern[i]).not.toBe(pattern[i - 1]);
        }
        expect(pattern[0]).toBe(1);
      }
    });

    it("has exactly seven timed selections: A B A B A B A", () => {
      expect(getManualPickOrder()).toEqual([1, 2, 1, 2, 1, 2, 1]);
      expect(getManualPickOrder()).toHaveLength(7);
    });

    it("maps pick indexes to lineups and ends after the seventh", () => {
      expect([0, 1, 2, 3, 4, 5, 6].map((i) => getPickingLineup(i))).toEqual([
        1, 2, 1, 2, 1, 2, 1,
      ]);
      expect(getPickingLineup(7)).toBeNull();
      expect(getPickingLineup(-1)).toBeNull();
    });

    it("fills both lineups evenly including the automatic last slot", () => {
      const pattern = buildCaptainPickPattern();
      expect(pattern.filter((lineup) => lineup === 1)).toHaveLength(4);
      expect(pattern.filter((lineup) => lineup === 2)).toHaveLength(4);
    });

    it("rejects unsupported player counts", () => {
      for (const count of [0, 2, 3, 9, 10.5]) {
        expect(() => buildCaptainPickPattern(count)).toThrow(
          CaptainPickRuleError,
        );
      }
    });
  });

  describe("selectAutoPick", () => {
    it("picks the highest remaining ELO", () => {
      const available = [
        player("76561198000000005", 8000, 5),
        player("76561198000000003", 9000, 3),
        player("76561198000000007", 6000, 7),
      ];

      expect(selectAutoPick(available).steam_id).toBe("76561198000000003");
    });

    it("breaks an ELO tie by earlier queue time", () => {
      const available = [
        player("76561198000000005", 9000, 5),
        player("76561198000000003", 9000, 3),
      ];

      expect(selectAutoPick(available).steam_id).toBe("76561198000000003");
    });

    it("breaks a full tie by steam ID", () => {
      const available = [
        player("76561198000000900", 9000, 3),
        player("76561198000000800", 9000, 3),
      ];

      expect(selectAutoPick(available).steam_id).toBe("76561198000000800");
    });

    it("throws when nobody is left", () => {
      expect(() => selectAutoPick([])).toThrow(CaptainPickRuleError);
    });
  });

  describe("compareCaptainPickPriority", () => {
    it("compares 17-digit steam IDs without precision loss", () => {
      // Both round to the same double; string/number comparison would tie.
      const a = player("76561198000000001", 5000);
      const b = player("76561198000000002", 5000);
      expect(Number(a.steam_id)).toBe(Number(b.steam_id));
      expect(compareCaptainPickPriority(a, b)).toBeLessThan(0);
      expect(compareCaptainPickPriority(b, a)).toBeGreaterThan(0);
    });
  });

  describe("resolveLastPlayerLineup", () => {
    it("assigns the last player to the only lineup with room", () => {
      expect(
        resolveLastPlayerLineup(
          { 1: ["a", "b", "c", "d"], 2: ["e", "f", "g", "h", "i"] },
          1,
        ),
      ).toBe(1);
      expect(
        resolveLastPlayerLineup(
          { 1: ["a", "b", "c", "d", "e"], 2: ["f", "g", "h", "i"] },
          1,
        ),
      ).toBe(2);
    });

    it("refuses anything but exactly one remaining player and a 5/4 split", () => {
      expect(() =>
        resolveLastPlayerLineup(
          { 1: ["a", "b", "c", "d"], 2: ["e", "f", "g", "h"] },
          2,
        ),
      ).toThrow(CaptainPickRuleError);
      expect(() =>
        resolveLastPlayerLineup(
          { 1: ["a", "b", "c"], 2: ["e", "f", "g", "h", "i"] },
          1,
        ),
      ).toThrow(CaptainPickRuleError);
    });
  });

  describe("full draft", () => {
    it("starts with the lower-ELO captain on lineup 1 and 8 in the pool", () => {
      const draft = createCaptainPickDraft(tenPlayers());

      expect(draft.captains[1].steam_id).toBe("76561198000000002");
      expect(draft.captains[2].steam_id).toBe("76561198000000001");
      expect(draft.firstPickReason).toBe("LowerElo");
      expect(draft.lineups).toEqual({
        1: ["76561198000000002"],
        2: ["76561198000000001"],
      });
      expect(draft.available).toHaveLength(8);
      expect(draft.pickIndex).toBe(0);
    });

    it("finishes 5v5 after seven auto-picks with the last player assigned automatically", () => {
      let draft = createCaptainPickDraft(tenPlayers());
      const pickingLineups: number[] = [];

      for (let i = 0; i < 7; i++) {
        expect(draft.pickIndex).toBe(i);
        pickingLineups.push(getPickingLineup(draft.pickIndex!)!);
        draft = applyCaptainAutoPick(draft);
      }

      expect(pickingLineups).toEqual([1, 2, 1, 2, 1, 2, 1]);
      expect(draft.pickIndex).toBeNull();
      expect(draft.available).toHaveLength(0);
      expect(draft.selections).toHaveLength(7);
      expect(draft.selections.every((selection) => selection.auto)).toBe(true);
      expect(draft.lineups[1]).toHaveLength(CAPTAIN_PICK_TEAM_SIZE);
      expect(draft.lineups[2]).toHaveLength(CAPTAIN_PICK_TEAM_SIZE);

      const everyone = [...draft.lineups[1], ...draft.lineups[2]];
      expect(new Set(everyone).size).toBe(CAPTAIN_PICK_PLAYER_COUNT);

      // Auto-picks always take the best remaining player, so the one left
      // over (the lowest ELO) lands on lineup 2 without a selection: exactly
      // what the eighth alternating pick (Captain B) would have been.
      expect(draft.lineups[2].at(-1)).toBe("76561198000000010");
    });

    it("with best-available picks the ELO ranks split #2 #3 #5 #7 #9 vs #1 #4 #6 #8 #10", () => {
      let draft = createCaptainPickDraft(tenPlayers());
      // tenPlayers() ids end in the ELO rank (…01 is the highest ELO).
      const rank = (steamId: string) => Number(steamId.slice(-2));
      while (draft.pickIndex !== null) draft = applyCaptainAutoPick(draft);

      expect(draft.lineups[1].map(rank).sort((a, b) => a - b)).toEqual([2, 3, 5, 7, 9]);
      expect(draft.lineups[2].map(rank).sort((a, b) => a - b)).toEqual([1, 4, 6, 8, 10]);
      // Captains are still the two highest ELO, the lower one first.
      expect(rank(draft.captains[1].steam_id)).toBe(2);
      expect(rank(draft.captains[2].steam_id)).toBe(1);
      // Selections alternate and no lineup ever picks twice in a row.
      const lineups = draft.selections.map((selection) => selection.lineup);
      expect(lineups).toEqual([1, 2, 1, 2, 1, 2, 1]);
    });

    it("hands each next turn to the other captain after every pick, manual or timed out", () => {
      let draft = createCaptainPickDraft(tenPlayers());
      const turns: number[] = [];
      for (let i = 0; i < 7; i++) {
        turns.push(getPickingLineup(draft.pickIndex!)!);
        draft =
          i % 2 === 0
            ? applyCaptainPick(draft, draft.available[draft.available.length - 1].steam_id)
            : applyCaptainAutoPick(draft);
      }
      expect(turns).toEqual([1, 2, 1, 2, 1, 2, 1]);
      expect(draft.pickIndex).toBeNull();
      expect(draft.selections.map((selection) => selection.auto)).toEqual([
        false, true, false, true, false, true, false,
      ]);
    });

    it("records manual picks in order and never mutates the previous draft", () => {
      const start = createCaptainPickDraft(tenPlayers());
      const afterFirst = applyCaptainPick(start, "76561198000000008");

      expect(start.pickIndex).toBe(0);
      expect(start.available).toHaveLength(8);
      expect(start.lineups[1]).toHaveLength(1);

      expect(afterFirst.pickIndex).toBe(1);
      expect(afterFirst.lineups[1]).toEqual([
        "76561198000000002",
        "76561198000000008",
      ]);
      expect(afterFirst.selections).toEqual([
        {
          pickIndex: 0,
          lineup: 1,
          steam_id: "76561198000000008",
          auto: false,
        },
      ]);
    });

    it("rejects picking a captain, an already-picked player or an unknown player", () => {
      const draft = createCaptainPickDraft(tenPlayers());
      const afterFirst = applyCaptainPick(draft, "76561198000000008");

      expect(() => applyCaptainPick(draft, "76561198000000001")).toThrow(
        /not available/,
      );
      expect(() => applyCaptainPick(afterFirst, "76561198000000008")).toThrow(
        /not available/,
      );
      expect(() => applyCaptainPick(draft, "76561198999999999")).toThrow(
        /not available/,
      );
    });

    it("rejects any pick once the teams are complete", () => {
      let draft = createCaptainPickDraft(tenPlayers());
      for (let i = 0; i < 7; i++) {
        draft = applyCaptainAutoPick(draft);
      }

      expect(() => applyCaptainPick(draft, "76561198000000010")).toThrow(
        /already complete/,
      );
      expect(() => applyCaptainAutoPick(draft)).toThrow(CaptainPickRuleError);
    });

    it("uses the coin flip for exactly equal captains", () => {
      const players = tenPlayers();
      players[3] = player("76561198000000002", 12500, 2);

      expect(() => createCaptainPickDraft(players)).toThrow(/coin flip/);

      const heads = createCaptainPickDraft(players, 0);
      const tails = createCaptainPickDraft(players, 1);

      expect(heads.firstPickReason).toBe("EqualEloCoinFlip");
      expect(heads.captains[1].steam_id).toBe("76561198000000001");
      expect(tails.captains[1].steam_id).toBe("76561198000000002");
    });
  });
});
