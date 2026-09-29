import {
  CAPTAIN_PICK_ENABLED_SETTING,
  CAPTAIN_PICK_SECONDS_SETTING,
  parseCaptainPickEnabled,
  parseCaptainPickSeconds,
  parseCaptainPickSettings,
  startCaptainPickTimer,
} from "./captain-pick-settings";
import { CaptainPickSettingsService } from "./captain-pick-settings.service";

describe("Captain Pick settings", () => {
  it("uses the approved setting names", () => {
    expect(CAPTAIN_PICK_ENABLED_SETTING).toBe(
      "public.matchmaking_competitive_captain_pick",
    );
    expect(CAPTAIN_PICK_SECONDS_SETTING).toBe(
      "public.matchmaking_captain_pick_seconds",
    );
  });

  describe("enabled flag", () => {
    it("is off when missing", () => {
      expect(parseCaptainPickEnabled(undefined)).toBe(false);
      expect(parseCaptainPickEnabled(null)).toBe(false);
    });

    it('is on only for exactly "true"', () => {
      expect(parseCaptainPickEnabled("true")).toBe(true);
      for (const value of ["false", "", "TRUE", "True", " true", "1", "yes"]) {
        expect(parseCaptainPickEnabled(value)).toBe(false);
      }
    });
  });

  describe("pick seconds", () => {
    it("defaults to 30 when missing or empty", () => {
      expect(parseCaptainPickSeconds(undefined)).toBe(30);
      expect(parseCaptainPickSeconds(null)).toBe(30);
      expect(parseCaptainPickSeconds("")).toBe(30);
      expect(parseCaptainPickSeconds("  ")).toBe(30);
    });

    it("accepts valid values", () => {
      expect(parseCaptainPickSeconds("10")).toBe(10);
      expect(parseCaptainPickSeconds("45")).toBe(45);
      expect(parseCaptainPickSeconds(" 60 ")).toBe(60);
      expect(parseCaptainPickSeconds("120")).toBe(120);
      expect(parseCaptainPickSeconds(20)).toBe(20);
    });

    it("falls back to 30 for non-numbers", () => {
      for (const value of ["abc", "20s", "NaN", "Infinity", "-Infinity"]) {
        expect(parseCaptainPickSeconds(value)).toBe(30);
      }
    });

    it("clamps below the minimum to 10", () => {
      expect(parseCaptainPickSeconds("9")).toBe(10);
      expect(parseCaptainPickSeconds("0")).toBe(10);
      expect(parseCaptainPickSeconds("-5")).toBe(10);
    });

    it("clamps above the maximum to 120", () => {
      expect(parseCaptainPickSeconds("121")).toBe(120);
      expect(parseCaptainPickSeconds("100000")).toBe(120);
    });

    it("rounds fractional seconds down", () => {
      expect(parseCaptainPickSeconds("29.9")).toBe(29);
    });
  });

  it("reads both settings from rows and ignores unrelated ones", () => {
    expect(parseCaptainPickSettings([])).toEqual({
      enabled: false,
      pickSeconds: 30,
    });
    expect(
      parseCaptainPickSettings([
        { name: "public.matchmaking_competitive", value: "true" },
        { name: CAPTAIN_PICK_ENABLED_SETTING, value: "true" },
        { name: CAPTAIN_PICK_SECONDS_SETTING, value: "20" },
      ]),
    ).toEqual({ enabled: true, pickSeconds: 20 });
  });

  describe("pick timer snapshot", () => {
    const start = new Date("2026-09-29T12:00:00.000Z");

    it("sets the deadline from the timer value when the pick starts", () => {
      const timer = startCaptainPickTimer(start, 30);
      expect(timer.timerSeconds).toBe(30);
      expect(timer.deadline.toISOString()).toBe("2026-09-29T12:00:30.000Z");
    });

    it("keeps a running deadline when the setting changes, and uses the new value next pick", () => {
      let setting = "30";
      const current = startCaptainPickTimer(
        start,
        parseCaptainPickSeconds(setting),
      );

      setting = "20";

      expect(current.deadline.toISOString()).toBe("2026-09-29T12:00:30.000Z");

      const next = startCaptainPickTimer(
        current.deadline,
        parseCaptainPickSeconds(setting),
      );
      expect(next.timerSeconds).toBe(20);
      expect(next.deadline.toISOString()).toBe("2026-09-29T12:00:50.000Z");
    });

    it("clamps an out-of-range timer value", () => {
      expect(startCaptainPickTimer(start, 1).timerSeconds).toBe(10);
      expect(startCaptainPickTimer(start, 999).timerSeconds).toBe(120);
    });
  });

  describe("CaptainPickSettingsService", () => {
    it("queries only the Captain Pick settings and parses them", async () => {
      const hasura = {
        query: jest.fn().mockResolvedValue({
          settings: [{ name: CAPTAIN_PICK_SECONDS_SETTING, value: "500" }],
        }),
      };
      const service = new CaptainPickSettingsService(hasura as any);

      await expect(service.getSettings()).resolves.toEqual({
        enabled: false,
        pickSeconds: 120,
      });
      expect(
        hasura.query.mock.calls[0][0].settings.__args.where.name._in,
      ).toEqual([CAPTAIN_PICK_ENABLED_SETTING, CAPTAIN_PICK_SECONDS_SETTING]);
    });
  });
});
