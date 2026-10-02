jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";

// voidMatchElo guards: administrator only (even when called directly),
// played matches only, idempotent, and it reuses the single-run ELO
// recompute (one follow-up run when a recompute is already in progress).
describe("MatchesController.voidMatchElo", () => {
  const make = (match: { status: string; elo_voided: boolean } | null, opts: { running?: boolean; updated?: boolean } = {}) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const postgres = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT status, elo_voided")) return match ? [match] : [];
        if (sql.includes("UPDATE matches")) return opts.updated === false ? [] : [{ id: "m1" }];
        return [];
      }),
    };
    const recompute = {
      isRunning: jest.fn(async () => !!opts.running),
      requestRerun: jest.fn(async () => {}),
      markQueued: jest.fn(async () => {}),
    };
    const queue = { add: jest.fn(async () => ({})) };
    const logger = { log: jest.fn() };
    const controller = Object.assign(Object.create(MatchesController.prototype), {
      postgres,
      playerEloRecompute: recompute,
      eloRecomputeQueue: queue,
      logger,
    }) as MatchesController;
    return { controller, postgres, queries, recompute, queue, logger };
  };
  const admin = { steam_id: "900", role: "administrator" } as any;
  const call = (controller: MatchesController, user: any) =>
    controller.voidMatchElo({ match_id: "m1", user });

  it.each(["user", "verified_user", "streamer", "moderator", "match_organizer", "tournament_organizer"])(
    "rejects a direct call from %s, touching nothing",
    async (role) => {
      const { controller, postgres, queue } = make({ status: "Finished", elo_voided: false });
      await expect(call(controller, { steam_id: "1", role })).rejects.toThrow(
        "you must be an administrator to void a match's ELO",
      );
      expect(postgres.query).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing user and a missing match", async () => {
    await expect(call(make({ status: "Finished", elo_voided: false }).controller, undefined)).rejects.toThrow("administrator");
    await expect(call(make(null).controller, admin)).rejects.toThrow("match not found");
  });

  it.each(["Canceled", "Live", "Veto", "WaitingForCheckIn", "WaitingForServer", "Scheduled", "PickingPlayers", "Setup"])(
    "rejects a %s match",
    async (status) => {
      const { controller, queries, queue } = make({ status, elo_voided: false });
      await expect(call(controller, admin)).rejects.toThrow("only a played match");
      expect(queries.some((q) => q.sql.includes("UPDATE matches"))).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it.each(["Finished", "Forfeit", "Tie", "Surrendered"])(
    "voids a %s match: flag, timestamp and admin, then one recompute",
    async (status) => {
      const { controller, queries, recompute, queue, logger } = make({ status, elo_voided: false });
      await expect(call(controller, admin)).resolves.toEqual({ success: true });
      const update = queries.find((q) => q.sql.includes("UPDATE matches"))!;
      expect(update.sql).toContain("elo_voided = true, elo_voided_at = now(), elo_voided_by = $2");
      expect(update.sql).toContain("WHERE id = $1 AND elo_voided = false");
      expect(update.params).toEqual(["m1", "900"]);
      expect(recompute.markQueued).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        "RecomputeAllElo",
        {},
        expect.objectContaining({ jobId: "RecomputeAllElo" }),
      );
      expect(logger.log).toHaveBeenCalledWith("[elo-void] match m1 ELO voided by 900");
    },
  );

  it("is idempotent: an already voided match changes nothing and starts no recompute", async () => {
    const { controller, queries, queue, recompute } = make({ status: "Finished", elo_voided: true });
    await expect(call(controller, admin)).resolves.toEqual({ success: true });
    expect(queries.some((q) => q.sql.includes("UPDATE matches"))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(recompute.requestRerun).not.toHaveBeenCalled();
  });

  it("a concurrent void (row already flipped) succeeds without a second recompute", async () => {
    const { controller, queue } = make({ status: "Finished", elo_voided: false }, { updated: false });
    await expect(call(controller, admin)).resolves.toEqual({ success: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("with a recompute already running: no duplicate run, one follow-up requested", async () => {
    const { controller, queue, recompute } = make({ status: "Finished", elo_voided: false }, { running: true });
    await expect(call(controller, admin)).resolves.toEqual({ success: true });
    expect(queue.add).not.toHaveBeenCalled();
    expect(recompute.markQueued).not.toHaveBeenCalled();
    expect(recompute.requestRerun).toHaveBeenCalledTimes(1);
  });
});
