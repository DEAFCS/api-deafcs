const listNamespacedJob = jest.fn();
const readNamespacedJob = jest.fn();
const deleteNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();
const deleteNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    listNamespacedJob = listNamespacedJob;
    readNamespacedJob = readNamespacedJob;
    deleteNamespacedJob = deleteNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
    deleteNamespacedPod = deleteNamespacedPod;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import { MatchAssistantService } from "./match-assistant.service";

// Upstream 5Stack's spec (5stackgg/api 085511d4) plus the DEAFCS guards:
// report-only unless enforced, m- Jobs only, matches that are not over keep
// their server, deleted matches wait out a grace, and every removal is
// confirmed against a fresh read of the Job and the match.
describe("MatchAssistantService — reconciling on-demand server Jobs", () => {
  const NOW = Date.parse("2026-09-16T12:00:00Z");
  const MINUTE = 60 * 1000;
  const MATCH_ID = "0b6f3c9e-4a57-4d2f-9f0e-3c2b1a0d9e8f";
  const JOB_NAME = `m-${MATCH_ID}`;

  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let store: Map<string, unknown>;
  let cache: {
    get: jest.Mock;
    has: jest.Mock;
    put: jest.Mock;
    forget: jest.Mock;
    lock: jest.Mock;
  };
  let logger: {
    warn: jest.Mock;
    log: jest.Mock;
    error: jest.Mock;
    verbose: jest.Mock;
  };
  let now: number;
  let enforce: boolean;
  let matches: Array<Record<string, unknown>>;
  let reservedServers: Array<{ id: string; reserved_by_match_id: string }>;
  // Live Kubernetes Jobs by name, as a fresh read sees them.
  let liveJobs: Map<string, ReturnType<typeof job>>;

  const job = (overrides: Record<string, any> = {}) => ({
    metadata: {
      name: JOB_NAME,
      uid: "uid-1",
      creationTimestamp: new Date(NOW - 60 * MINUTE),
      ...(overrides.metadata ?? {}),
    },
    status: { active: 1, ...(overrides.status ?? {}) },
  });

  const match = (overrides: Record<string, unknown> = {}) => ({
    id: MATCH_ID,
    status: "Live",
    ended_at: null as string | null,
    cancels_at: null as string | null,
    server_id: "server-1",
    options: { tv_delay: 120 },
    ...overrides,
  });

  const listJobs = (...items: Array<ReturnType<typeof job>>) => {
    liveJobs = new Map(items.map((item) => [item.metadata.name, item]));
  };

  const deletedJobs = () =>
    deleteNamespacedJob.mock.calls.map(([request]) => request.name);

  const warnings = () => logger.warn.mock.calls.map(([message]) => message);

  const sweep = () => service.reconcileOnDemandServerJobs();

  beforeEach(() => {
    for (const fn of [
      listNamespacedJob,
      readNamespacedJob,
      deleteNamespacedJob,
      listNamespacedPod,
      deleteNamespacedPod,
    ]) {
      fn.mockReset();
    }

    now = NOW;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    enforce = true;
    listJobs(job());
    listNamespacedJob.mockImplementation(async () => ({
      items: [...liveJobs.values()],
    }));
    readNamespacedJob.mockImplementation(async ({ name }) => {
      const found = liveJobs.get(name);
      if (!found) {
        throw { code: 404 };
      }
      return found;
    });
    deleteNamespacedJob.mockImplementation(async ({ name, body }) => {
      const found = liveJobs.get(name);
      if (!found) {
        throw { code: 404 };
      }
      if (body?.preconditions?.uid !== found.metadata.uid) {
        throw { code: 409 };
      }
      liveJobs.delete(name);
      return {};
    });
    listNamespacedPod.mockResolvedValue({ items: [] });
    deleteNamespacedPod.mockResolvedValue({});

    matches = [];
    reservedServers = [];

    hasura = {
      query: jest.fn(async (request: any) => {
        if (request.matches) {
          return { matches };
        }
        if (request.servers) {
          return { servers: reservedServers };
        }
        return {};
      }),
      mutation: jest.fn(async () => ({})),
    };

    store = new Map();
    cache = {
      get: jest.fn(async (key: string) => store.get(key)),
      has: jest.fn(async (key: string) => store.has(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return true;
      }),
      forget: jest.fn(async (...keys: Array<string>) => {
        keys.forEach((key) => store.delete(key));
        return true;
      }),
      lock: jest.fn(),
    };
    logger = {
      warn: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      verbose: jest.fn(),
    };

    service = new MatchAssistantService(
      logger as any,
      {} as any,
      cache as any,
      {
        get: jest.fn((key: string) =>
          key === "gameServers"
            ? {
                namespace: "test",
                get matchServerReaperEnforce() {
                  return enforce;
                },
              }
            : {},
        ),
      } as any,
      hasura as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { add: jest.fn() } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("a deleted match", () => {
    it("deletes its running Job once the grace has passed", async () => {
      await sweep();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 5 * MINUTE;
      await sweep();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    it("deletes a labelled Job whose match row is gone", async () => {
      listJobs(
        job({
          metadata: {
            labels: {
              app: "game-server",
              role: "match",
              "match-id": MATCH_ID,
            },
          },
        }),
      );

      await sweep();
      now += 5 * MINUTE;
      await sweep();

      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    it("keeps the Job when a server is still reserved by the missing match", async () => {
      await sweep();
      reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];
      now += 5 * MINUTE;
      await sweep();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(warnings()).toEqual([
        expect.stringContaining("match is gone but a server is still reserved"),
      ]);
    });
  });

  it("keeps a Live match's Job while it holds its on-demand server", async () => {
    matches = [match()];
    reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

    await sweep();
    now += 60 * MINUTE;
    await sweep();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The reservation, the Job and the server_id write are separate statements a sweep can land between.
  it("keeps a Job younger than the create grace", async () => {
    listJobs(job({ metadata: { creationTimestamp: new Date(NOW - MINUTE) } }));

    await sweep();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("ignores Jobs that already completed or failed", async () => {
    listJobs(
      job({
        status: {
          active: 0,
          conditions: [{ type: "Complete", status: "True" }],
        },
      }),
      job({
        metadata: {
          name: "m-1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
        },
        status: {
          active: 0,
          conditions: [{ type: "Failed", status: "True" }],
        },
      }),
    );

    await sweep();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("ignores Jobs that are not match servers", async () => {
    listJobs(
      job({
        metadata: {
          name: `gs-live-${MATCH_ID}`,
          labels: {
            app: "game-streamer",
            role: "live",
            "match-id": MATCH_ID,
          },
        },
      }),
      job({ metadata: { name: "gs-demo-0b6f3c9e4a57" } }),
      job({ metadata: { name: "gs-nades-queue" } }),
      job({ metadata: { name: "update-cs-server-node-1" } }),
      job({ metadata: { name: "validate-gamedata-12345-public" } }),
      job({ metadata: { name: "m-notauuid" } }),
    );

    await sweep();
    now += 60 * MINUTE;
    await sweep();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  // DEAFCS: upstream deletes these; Pracc stays outside the sweep.
  it("never looks at Pracc u- Jobs, labelled or not", async () => {
    listJobs(
      job({ metadata: { name: `u-${MATCH_ID}` } }),
      job({
        metadata: {
          name: "u-1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
          uid: "uid-2",
          labels: {
            app: "game-server",
            role: "match",
            "match-id": "1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f",
          },
        },
      }),
    );

    await sweep();
    now += 60 * MINUTE;
    await sweep();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(deleteNamespacedPod).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("lists only labelled Jobs once no unlabelled match server Job is left", async () => {
    const labelled = job({
      metadata: {
        labels: { app: "game-server", role: "match", "match-id": MATCH_ID },
      },
    });
    matches = [match()];
    reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

    await sweep();
    await sweep();

    listJobs(labelled);
    await sweep();
    await sweep();

    expect(
      listNamespacedJob.mock.calls.map(([request]) => request.labelSelector),
    ).toEqual([undefined, undefined, undefined, "app=game-server,role=match"]);
  });

  it("clears the orphan timers of every match holding its server in one call", async () => {
    const other = "1c0e2d3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
    listJobs(job(), job({ metadata: { name: `m-${other}`, uid: "uid-2" } }));
    matches = [match(), match({ id: other, server_id: "server-2" })];
    reservedServers = [
      { id: "server-1", reserved_by_match_id: MATCH_ID },
      { id: "server-2", reserved_by_match_id: other },
    ];

    await sweep();

    expect(cache.forget.mock.calls).toEqual([
      [
        "match-server-job:orphaned-since:uid-1",
        "match-server-job:orphaned-since:uid-2",
      ],
    ]);
  });

  it("deletes nothing when the Jobs cannot be listed", async () => {
    listNamespacedJob.mockRejectedValue(new Error("forbidden"));

    await expect(sweep()).resolves.toBeUndefined();

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("deletes nothing when the matches cannot be read", async () => {
    await sweep();
    hasura.query.mockRejectedValue(new Error("hasura unavailable"));
    now += 5 * MINUTE;

    await expect(sweep()).rejects.toThrow("hasura unavailable");

    expect(deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("deletes a Job only while it is still the one it listed", async () => {
    matches = [
      match({
        status: "Canceled",
        server_id: null,
        cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ];

    await sweep();

    expect(deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JOB_NAME,
        body: expect.objectContaining({ preconditions: { uid: "uid-1" } }),
      }),
    );
  });

  it("leaves a Job replaced after it was listed, and the rows its match holds", async () => {
    matches = [
      match({
        status: "Canceled",
        server_id: null,
        cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ];
    reservedServers = [{ id: "server-2", reserved_by_match_id: MATCH_ID }];
    deleteNamespacedJob.mockRejectedValue({ code: 409 });

    await sweep();

    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // Shares the one-worker scheduled-matches queue, and never reuses the name it removes.
  it("does not wait for a removed Job to disappear", async () => {
    matches = [
      match({
        status: "Canceled",
        server_id: null,
        cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ];

    await sweep();

    expect(deletedJobs()).toEqual([JOB_NAME]);
    // Only the confirmation read before the delete.
    expect(readNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("treats a Job that is already gone as deleted", async () => {
    matches = [
      match({
        status: "Canceled",
        server_id: null,
        cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ];
    deleteNamespacedJob.mockRejectedValue({ code: 404 });

    await expect(sweep()).resolves.toBeUndefined();

    expect(deletedJobs()).toEqual([JOB_NAME]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("a match that has ended", () => {
    it("deletes a Canceled match's Job once the grace has passed", async () => {
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - MINUTE).toISOString(),
        }),
      ];

      await sweep();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 15 * MINUTE;
      await sweep();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    // GOTV keeps broadcasting for tv_delay after the last round.
    it("waits out tv_delay before deleting a Finished match's Job", async () => {
      matches = [
        match({
          status: "Finished",
          server_id: null,
          ended_at: new Date(NOW - 11 * MINUTE).toISOString(),
          options: { tv_delay: 5 * 60 },
        }),
      ];

      await sweep();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 5 * MINUTE;
      await sweep();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    it("counts the grace from when it first saw a match with no end time", async () => {
      matches = [match({ status: "Surrendered", server_id: null })];

      await sweep();
      now += 5 * MINUTE;
      await sweep();
      expect(deleteNamespacedJob).not.toHaveBeenCalled();

      now += 10 * MINUTE;
      await sweep();
      expect(deletedJobs()).toEqual([JOB_NAME]);
    });

    // tau_matches only frees the server_id it can see.
    it("releases the on-demand server the match still held", async () => {
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
        }),
      ];
      reservedServers = [{ id: "server-2", reserved_by_match_id: MATCH_ID }];

      await sweep();

      expect(deletedJobs()).toEqual([JOB_NAME]);
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_servers: expect.objectContaining({
            __args: expect.objectContaining({
              where: {
                reserved_by_match_id: { _eq: MATCH_ID },
                id: { _eq: "server-2" },
                _or: [
                  {
                    current_match: {
                      status: {
                        _in: expect.arrayContaining(["Canceled", "Finished"]),
                      },
                    },
                  },
                  { _not: { matches: { id: { _eq: MATCH_ID } } } },
                ],
              },
            }),
          }),
        }),
      );
    });
  });

  // DEAFCS: upstream deletes a match's Job 5 minutes after it stops holding
  // its server. A match that is not over keeps it.
  describe("a match that is not over", () => {
    const sweepForAnHour = async () => {
      for (let i = 0; i < 60; i++) {
        await sweep();
        now += MINUTE;
      }
    };

    it("keeps a Live match's Job that no longer holds its server, and reports it once", async () => {
      matches = [match({ status: "Live", server_id: null })];

      await sweepForAnHour();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(warnings()).toEqual([
        expect.stringContaining("match is Live but does not hold its server"),
      ]);
    });

    // Finished clears the reservation (tau_matches); a tournament reset keeps
    // server_id and puts the match back to WaitingForCheckIn, from where it
    // goes Live on the server that is still running.
    it("keeps the server of a finished match reset to WaitingForCheckIn", async () => {
      matches = [match({ status: "WaitingForCheckIn" })];

      await sweepForAnHour();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    // Restarted inside its GOTV window, while the stop was still pending.
    it("keeps the server of a finished match that is Live again without a reservation", async () => {
      matches = [
        match({
          status: "Finished",
          ended_at: new Date(NOW - MINUTE).toISOString(),
        }),
      ];
      await sweep();
      now += MINUTE;

      matches = [match({ status: "Live" })];
      await sweepForAnHour();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    it("keeps a server whose match was reset between the sweep's read and the removal", async () => {
      let reads = 0;
      hasura.query.mockImplementation(async (request: any) => {
        if (request.matches) {
          reads++;
          return {
            matches: [
              reads === 1
                ? match({
                    status: "Finished",
                    ended_at: new Date(NOW - 60 * MINUTE).toISOString(),
                  })
                : match({ status: "WaitingForCheckIn" }),
            ],
          };
        }
        return { servers: [] };
      });

      await sweep();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(warnings()).toEqual([
        expect.stringContaining("match is WaitingForCheckIn again"),
      ]);
    });

    it.each([
      ["Captain Pick drafting", "PickingPlayers"],
      ["veto", "Veto"],
      ["check-in", "WaitingForCheckIn"],
      ["a pending allocation", "WaitingForServer"],
      ["a scheduled match", "Scheduled"],
    ])("keeps the server during %s", async (_, status) => {
      // Reserved, but server_id is not written yet (assignOnDemandServer).
      matches = [match({ status, server_id: null })];
      reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

      await sweepForAnHour();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    // A node going offline does not clear the reservation.
    it("keeps a recovering Live match's server while it is reserved", async () => {
      matches = [match()];
      reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];

      await sweepForAnHour();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("forgets a match that went back to holding its server", async () => {
      matches = [match({ status: "Live", server_id: null })];
      await sweep();

      matches = [match()];
      reservedServers = [{ id: "server-1", reserved_by_match_id: MATCH_ID }];
      now += 10 * MINUTE;
      await sweep();

      expect(store.has("match-server-job:orphaned-since:uid-1")).toBe(false);
      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });
  });

  describe("confirming before a removal", () => {
    beforeEach(() => {
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
        }),
      ];
    });

    it("keeps a Job that was replaced after the list (new uid)", async () => {
      readNamespacedJob.mockResolvedValue(job({ metadata: { uid: "uid-2" } }));

      await sweep();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    it("keeps a Job that finished after the list", async () => {
      readNamespacedJob.mockResolvedValue(
        job({
          status: {
            active: 0,
            conditions: [{ type: "Complete", status: "True" }],
          },
        }),
      );

      await sweep();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    it("keeps a Job that is already gone", async () => {
      readNamespacedJob.mockRejectedValue({ code: 404 });

      await sweep();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
    });

    it("keeps the server when the confirmation read fails", async () => {
      readNamespacedJob.mockRejectedValue({ code: 500 });

      await expect(sweep()).resolves.toBeUndefined();

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // DEAFCS: nothing is removed until MATCH_SERVER_REAPER=enforce.
  describe("report-only (the default)", () => {
    beforeEach(() => {
      enforce = false;
      matches = [
        match({
          status: "Canceled",
          server_id: null,
          cancels_at: new Date(NOW - 60 * MINUTE).toISOString(),
        }),
      ];
      reservedServers = [{ id: "server-2", reserved_by_match_id: MATCH_ID }];
    });

    it("reports what it would remove, once, and touches nothing", async () => {
      for (let i = 0; i < 10; i++) {
        await sweep();
        now += MINUTE;
      }

      expect(deleteNamespacedJob).not.toHaveBeenCalled();
      expect(deleteNamespacedPod).not.toHaveBeenCalled();
      expect(hasura.mutation).not.toHaveBeenCalled();
      expect(warnings()).toEqual([
        expect.stringContaining(
          `would remove orphaned on demand server job ${JOB_NAME}`,
        ),
      ]);
    });

    it("reads the config on every sweep", async () => {
      await sweep();
      enforce = true;
      await sweep();

      expect(deletedJobs()).toEqual([JOB_NAME]);
    });
  });

  it("removes at most three Jobs in one sweep", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    listJobs(
      ...ids.map((id, i) =>
        job({ metadata: { name: `m-${id}`, uid: `uid-${i}` } }),
      ),
    );

    await sweep();
    now += 5 * MINUTE;
    await sweep();

    expect(deletedJobs()).toHaveLength(3);

    now += MINUTE;
    await sweep();

    expect(deletedJobs()).toHaveLength(5);
  });
});
