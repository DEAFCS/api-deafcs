import {
  CAPTAIN_PICK_DISABLED_ERROR,
  CAPTAIN_PICK_NOT_COMPETITIVE_ERROR,
  CAPTAIN_PICK_SOLO_ONLY_ERROR,
  getCaptainPickJoinError,
} from "./captain-pick-queue-rules";

describe("getCaptainPickJoinError", () => {
  it("allows a solo Competitive player when enabled", () => {
    expect(
      getCaptainPickJoinError({
        type: "Competitive",
        enabled: true,
        partySize: 1,
      }),
    ).toBeUndefined();
  });

  it("rejects every party larger than one", () => {
    for (const partySize of [2, 3, 4, 5, 10]) {
      expect(
        getCaptainPickJoinError({
          type: "Competitive",
          enabled: true,
          partySize,
        }),
      ).toBe(CAPTAIN_PICK_SOLO_ONLY_ERROR);
    }
  });

  it("rejects an empty lobby", () => {
    expect(
      getCaptainPickJoinError({
        type: "Competitive",
        enabled: true,
        partySize: 0,
      }),
    ).toBe(CAPTAIN_PICK_SOLO_ONLY_ERROR);
  });

  it("rejects when the feature is off", () => {
    expect(
      getCaptainPickJoinError({
        type: "Competitive",
        enabled: false,
        partySize: 1,
      }),
    ).toBe(CAPTAIN_PICK_DISABLED_ERROR);
  });

  it("rejects every non-Competitive type", () => {
    for (const type of ["Wingman", "Duel", "Premier", "Faceit"] as const) {
      expect(
        getCaptainPickJoinError({ type, enabled: true, partySize: 1 }),
      ).toBe(CAPTAIN_PICK_NOT_COMPETITIVE_ERROR);
    }
  });

  it("keeps user-facing messages free of em dashes", () => {
    for (const message of [
      CAPTAIN_PICK_DISABLED_ERROR,
      CAPTAIN_PICK_NOT_COMPETITIVE_ERROR,
      CAPTAIN_PICK_SOLO_ONLY_ERROR,
    ]) {
      expect(message).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
