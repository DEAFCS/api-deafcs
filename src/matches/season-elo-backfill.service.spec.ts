import { SeasonEloBackfillService } from "./season-elo-backfill.service";
import { RefreshAllPlayersJob } from "../type-sense/jobs/RefreshAllPlayers";

describe("SeasonEloBackfillService player reindex", () => {
  it("schedules exactly one deduplicated full reindex and skips a duplicate run", async () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    const postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SELECT m.id::text AS id")) {
          return [];
        }
        return [];
      }),
    };
    const cache = {
      acquireLock: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      forget: jest.fn(),
      get: jest.fn().mockResolvedValue(false),
      put: jest.fn(),
      refreshLock: jest.fn(),
    };
    const notifications = { send: jest.fn() };
    const eloRecompute = { setSuppressEvents: jest.fn() };
    const reindexQueue = { add: jest.fn() };
    const service = new SeasonEloBackfillService(
      logger as any,
      postgres as any,
      cache as any,
      notifications as any,
      eloRecompute as any,
      reindexQueue as any,
    );

    await service.runBackfill("season-1");
    await service.runBackfill("season-1");

    expect(reindexQueue.add).toHaveBeenCalledTimes(1);
    expect(reindexQueue.add).toHaveBeenCalledWith(
      RefreshAllPlayersJob.name,
      {},
      {
        jobId: RefreshAllPlayersJob.name,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(eloRecompute.setSuppressEvents).toHaveBeenNthCalledWith(1, true);
    expect(eloRecompute.setSuppressEvents).toHaveBeenNthCalledWith(2, false);
    expect(logger.warn).toHaveBeenCalledWith(
      "[season-backfill] already running, skipping duplicate",
    );
  });
});
