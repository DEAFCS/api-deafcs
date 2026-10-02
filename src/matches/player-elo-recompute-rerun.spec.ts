import { PlayerEloRecomputeService } from "./player-elo-recompute.service";

// A match's ELO voided while a full recompute runs: that run may already have
// rebuilt it with the old rating effect, so exactly one follow-up run is
// queued when it finishes (never a concurrent one).
describe("PlayerEloRecomputeService follow-up run for an ELO void", () => {
  const make = ({ voidDuringRun = false, cancelDuringRun = false } = {}) => {
    const store = new Map<string, unknown>();
    const cache = {
      get: jest.fn(async (key: string) => store.get(key)),
      put: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
      forget: jest.fn(async (key: string) => void store.delete(key)),
      acquireLock: jest.fn(async () => true),
      refreshLock: jest.fn(async () => true),
    };
    let service: PlayerEloRecomputeService;
    const postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SELECT id::text AS id")) return [{ id: "m1" }, { id: "m2" }];
        if (sql.includes("generate_player_elo_for_match")) {
          // The void (and/or an admin cancel) lands mid-run.
          if (voidDuringRun) await service.requestRerun();
          if (cancelDuringRun) store.set("elo-recompute:cancel", true);
        }
        return [];
      }),
    };
    const reindexQueue = { add: jest.fn(async () => ({})) };
    const eloRecomputeQueue = { add: jest.fn(async () => ({})) };
    service = new PlayerEloRecomputeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      postgres as any,
      cache as any,
      { notifyPlayers: jest.fn(async () => {}) } as any,
      reindexQueue as any,
      eloRecomputeQueue as any,
    );
    (service as any).notifyComplete = jest.fn(async () => {});
    return { service, store, eloRecomputeQueue };
  };

  it("a void during the run queues exactly one follow-up run with its own job id", async () => {
    const { service, store, eloRecomputeQueue } = make({ voidDuringRun: true });
    await service.runRecomputeAll();
    expect(eloRecomputeQueue.add).toHaveBeenCalledTimes(1);
    const [name, , opts] = eloRecomputeQueue.add.mock.calls[0] as any[];
    expect(name).toBe("RecomputeAllElo");
    expect(opts.jobId).toMatch(/^RecomputeAllElo:rerun:\d+$/);
    expect(store.has("elo-recompute:rerun-requested")).toBe(false);
    // Shown as running/queued again for the admin status UI.
    expect((store.get("elo-recompute:status") as any).running).toBe(true);
  });

  it("no void: no follow-up run", async () => {
    const { service, eloRecomputeQueue } = make();
    await service.runRecomputeAll();
    expect(eloRecomputeQueue.add).not.toHaveBeenCalled();
  });

  it("a request made before the run started is satisfied by that run itself", async () => {
    const { service, store, eloRecomputeQueue } = make();
    store.set("elo-recompute:rerun-requested", true);
    await service.runRecomputeAll();
    expect(eloRecomputeQueue.add).not.toHaveBeenCalled();
  });

  it("a canceled run keeps the request for the next run instead of rerunning now", async () => {
    const { service, store, eloRecomputeQueue } = make({ voidDuringRun: true, cancelDuringRun: true });
    await service.runRecomputeAll();
    expect(eloRecomputeQueue.add).not.toHaveBeenCalled();
    expect(store.get("elo-recompute:rerun-requested")).toBe(true);
  });
});
