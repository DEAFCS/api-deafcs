const readNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();
const readNode = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    readNamespacedJob = readNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
    readNode = readNode;
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
import { MatchesController } from "../matches.controller";

// DEAFCS: an on-demand server freed by an ended or deleted match is marked
// draining (tau_matches / tbd_matches) and only handed out again once
// Kubernetes shows that match's pod is gone from it.
describe("MatchAssistantService — draining on-demand servers", () => {
  const NOW = Date.parse("2026-10-20T18:00:00Z");
  const MINUTE = 60 * 1000;
  const MATCH_ID = "5e0c1f7a-3b2d-4c6e-8f9a-0b1c2d3e4f5a";
  const SERVER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const OTHER_SERVER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  const JOB_NAME = `m-${MATCH_ID}`;
  const NODE_ID = "kernelhost";

  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let scheduledMatchesQueue: { add: jest.Mock };
  let store: Map<string, unknown>;
  let logger: Record<string, jest.Mock>;
  let now: number;
  let source: string;
  let draining: Array<{ id: string; match_id: string; check_at: Date }>;
  let jobs: Map<string, unknown>;
  let pods: Array<unknown>;
  // The server's node's Ready condition; null when the node is not there.
  let nodeReady: string | null;

  const spec = (serverId: string | null = SERVER_ID) => ({
    containers: [
      {
        name: "game-server",
        env: [
          { name: "SERVER_PORT", value: "27015" },
          ...(serverId ? [{ name: "SERVER_ID", value: serverId }] : []),
        ],
      },
    ],
  });

  const job = (options: { finished?: boolean; serverId?: string } = {}) => ({
    metadata: { name: JOB_NAME, uid: "uid-1" },
    spec: { template: { spec: spec(options.serverId) } },
    status: options.finished
      ? { conditions: [{ type: "Complete", status: "True" }] }
      : { active: 1 },
  });

  const pod = (
    phase: string,
    options: { serverId?: string | null; terminating?: boolean } = {},
  ) => ({
    metadata: {
      name: `${JOB_NAME}-abcde`,
      ...(options.terminating ? { deletionTimestamp: new Date(NOW) } : {}),
    },
    spec: spec(options.serverId === undefined ? SERVER_ID : options.serverId),
    status: { phase },
  });

  const drainingServer = (checkAt = NOW - MINUTE) => {
    draining = [
      {
        id: SERVER_ID,
        match_id: MATCH_ID,
        check_at: new Date(checkAt),
        node_id: NODE_ID,
      },
    ];
  };

  const releases = () =>
    postgres.query.mock.calls.filter(([sql]) =>
      /SET draining_match_id = NULL/.test(sql),
    );

  const restops = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === "StopOnDemandServer",
    );

  const sweep = () => service.reconcileDrainingOnDemandServers();

  // Sweeps a minute apart, as the repeat job runs them.
  const sweepFor = async (minutes: number) => {
    for (let minute = 0; minute <= minutes; minute++) {
      if (minute > 0) {
        now += MINUTE;
      }
      await sweep();
    }
  };

  beforeEach(() => {
    readNamespacedJob.mockReset();
    listNamespacedPod.mockReset();
    readNode.mockReset();
    nodeReady = "True";
    readNode.mockImplementation(async ({ name }) => {
      if (name !== NODE_ID || nodeReady === null) {
        throw { code: 404 };
      }
      return {
        status: { conditions: [{ type: "Ready", status: nodeReady }] },
      };
    });

    now = NOW;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    source = "matchmaking";
    jobs = new Map();
    pods = [];
    drainingServer();

    readNamespacedJob.mockImplementation(async ({ name }) => {
      if (!jobs.has(name)) {
        throw { code: 404 };
      }
      return jobs.get(name);
    });
    listNamespacedPod.mockImplementation(async ({ labelSelector }) => ({
      items: labelSelector === `job-name=${JOB_NAME}` ? pods : [],
    }));

    hasura = {
      query: jest.fn(async (request: any) => {
        if (request.matches_by_pk) {
          return { matches_by_pk: source ? { source } : null };
        }
        if (request.servers_aggregate) {
          return { servers_aggregate: { aggregate: { count: 0 } } };
        }
        return {};
      }),
      mutation: jest.fn(async () => ({})),
    };
    postgres = {
      query: jest.fn(async (sql: string) =>
        /FROM public.servers/.test(sql) && /SELECT/.test(sql) ? draining : [],
      ),
    };
    scheduledMatchesQueue = { add: jest.fn(async () => ({})) };

    store = new Map();
    const cache = {
      get: jest.fn(async (key: string) => store.get(key)),
      forget: jest.fn(async (...keys: Array<string>) => {
        keys.forEach((key) => store.delete(key));
        return true;
      }),
      has: jest.fn(async (key: string) => store.has(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return true;
      }),
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
          key === "gameServers" ? { namespace: "test" } : {},
        ),
      } as any,
      hasura as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      postgres as any,
      scheduledMatchesQueue as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("allocation", () => {
    it("never counts a draining server as free", async () => {
      await service.countFreeOnDemandServers("TestA");

      const [request] = hasura.query.mock.calls.at(0);
      expect(request.servers_aggregate.__args.where).toMatchObject({
        reserved_by_match_id: { _is_null: true },
        draining_match_id: { _is_null: true },
      });
    });

    it("assignOnDemandServer and countFreeOnDemandServers share the filter", () => {
      const fs = jest.requireActual("fs");
      const path = jest.requireActual("path");
      const source = fs.readFileSync(
        path.resolve(__dirname, "match-assistant.service.ts"),
        "utf8",
      );
      const assign = source.slice(
        source.indexOf("private async assignOnDemandServer("),
        source.indexOf("const server = servers.at(-1);"),
      );

      expect(assign).toContain("...MatchAssistantService.notDraining(),");
    });
  });

  describe("the sweep", () => {
    it("reads only servers that are due for a check", async () => {
      await sweep();

      const [sql] = postgres.query.mock.calls.at(0);
      expect(sql).toMatch(/draining_match_id IS NOT NULL/);
      expect(sql).toMatch(/draining_check_at <= now\(\)/);
    });

    it("frees a server once the match's Job finished and its pod exited", async () => {
      jobs.set(JOB_NAME, job({ finished: true }));
      pods = [pod("Succeeded")];

      await sweep();

      expect(releases()).toHaveLength(1);
      const [sql, params] = releases()[0];
      // Written only while the row still drains for this match.
      expect(sql).toMatch(/AND draining_match_id = \$2::uuid/);
      expect(params).toEqual([SERVER_ID, MATCH_ID]);
    });

    it("frees a server whose Job and pods are gone only after two minutes", async () => {
      // Nothing proves a pod deleted with no grace period has stopped.
      await sweepFor(1);
      expect(releases()).toHaveLength(0);

      now += MINUTE;
      await sweep();
      expect(releases()).toHaveLength(1);
    });

    it("waits again when the server is seen in use in between", async () => {
      await sweep();
      now += MINUTE;
      jobs.set(JOB_NAME, job());
      await sweep();
      jobs.delete(JOB_NAME);
      await sweepFor(1);

      expect(releases()).toHaveLength(0);

      await sweepFor(1);
      expect(releases()).toHaveLength(1);
    });

    it("does not free a server right after its ignoring pod was force deleted", async () => {
      // The stop check deleted the Job, then its pods with no grace period.
      jobs.set(JOB_NAME, job());
      pods = [pod("Running")];
      await sweep();

      jobs.delete(JOB_NAME);
      pods = [];
      now += MINUTE;
      await sweep();
      now += MINUTE;
      await sweep();

      expect(releases()).toHaveLength(0);
    });

    it("frees a server whose old pod failed and whose Job gave up", async () => {
      jobs.set(JOB_NAME, {
        ...job(),
        status: { conditions: [{ type: "Failed", status: "True" }] },
      });
      pods = [pod("Failed")];

      await sweep();

      expect(releases()).toHaveLength(1);
    });

    it.each([
      ["running", () => pod("Running")],
      ["pending", () => pod("Pending")],
      ["terminating", () => pod("Running", { terminating: true })],
      ["on an unreachable node", () => pod("Unknown")],
      ["without a SERVER_ID", () => pod("Running", { serverId: null })],
    ])("keeps a server while the match's pod is %s", async (_, make) => {
      jobs.set(JOB_NAME, job({ finished: true }));
      pods = [make()];

      await sweep();

      expect(releases()).toHaveLength(0);
    });

    it("keeps a server while the Job can still start a pod on it", async () => {
      // A failed pod is replaced (backoffLimit) on the same node and ports.
      jobs.set(JOB_NAME, job());
      pods = [pod("Failed")];

      await sweep();

      expect(releases()).toHaveLength(0);
    });

    it("frees the old server of a match now running on another one", async () => {
      // Tournament reset / restart: Live again under the same Job name, booted
      // on a different server.
      jobs.set(JOB_NAME, job({ serverId: OTHER_SERVER_ID }));
      pods = [pod("Running", { serverId: OTHER_SERVER_ID }), pod("Succeeded")];

      // The old Job (and its pods) were removed when the match was given its
      // new server, so nothing proves the old pod stopped: wait it out.
      await sweepFor(1);
      expect(releases()).toHaveLength(0);
      await sweepFor(1);
      expect(releases()).toHaveLength(1);
    });

    it("checks a practice match's u- Job as well", async () => {
      source = "practice";
      const practiceJob = `u-${MATCH_ID}`;
      jobs.set(practiceJob, { ...job(), metadata: { name: practiceJob } });

      await sweep();

      expect(readNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ name: practiceJob }),
      );
      expect(releases()).toHaveLength(0);
    });

    it("checks both names for a deleted match", async () => {
      source = "";

      await sweep();

      expect(readNamespacedJob.mock.calls.map(([r]) => r.name)).toEqual([
        `u-${MATCH_ID}`,
        JOB_NAME,
      ]);
      expect(releases()).toHaveLength(0);

      await sweepFor(2);
      expect(releases()).toHaveLength(1);
    });

    describe("when the check fails, the server stays out", () => {
      it.each([
        [
          "the Job cannot be read",
          () => readNamespacedJob.mockRejectedValue({ code: 500 }),
        ],
        [
          "the pods cannot be listed",
          () => listNamespacedPod.mockRejectedValue(new Error("ECONNREFUSED")),
        ],
        [
          "the match cannot be read",
          () => hasura.query.mockRejectedValue(new Error("hasura down")),
        ],
      ])("%s", async (_, fail) => {
        fail();

        await sweep();
        await sweep();

        expect(releases()).toHaveLength(0);
        expect(restops()).toHaveLength(0);
        // One warning per server per 10 minutes, not one a minute.
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toMatch(
          /keeping it out of rotation/,
        );
      });

      it("the cache cannot be read", async () => {
        (service as any).cache.get.mockRejectedValue(new Error("redis down"));

        await expect(sweepFor(3)).rejects.toThrow("redis down");

        expect(releases()).toHaveLength(0);
      });

      it("however long it has been draining", async () => {
        drainingServer(NOW - 24 * 60 * MINUTE);
        readNamespacedJob.mockRejectedValue({ code: 503 });

        await sweep();

        expect(releases()).toHaveLength(0);
      });
    });

    describe("the server's node", () => {
      it.each([
        ["not ready", "False"],
        ["unreachable", "Unknown"],
        ["gone from the cluster", null],
      ])(
        "keeps a server whose pods vanished while its node is %s",
        async (_, ready) => {
          nodeReady = ready;

          await sweepFor(30);

          expect(releases()).toHaveLength(0);
          expect(restops()).toHaveLength(0);
          expect(
            logger.warn.mock.calls.filter(([m]) => /is not ready/.test(m)),
          ).toHaveLength(1); // rate limited (10 min key; the mock cache never expires)
        },
      );

      it("waits the full two minutes again once the node is back", async () => {
        await sweep();
        now += MINUTE;
        nodeReady = "Unknown";
        await sweepFor(5);
        nodeReady = "True";
        now += MINUTE;
        await sweepFor(1);

        expect(releases()).toHaveLength(0);

        now += MINUTE;
        await sweep();
        expect(releases()).toHaveLength(1);
      });

      it("keeps a server whose node cannot be read", async () => {
        readNode.mockRejectedValue({ code: 500 });

        await sweepFor(5);

        expect(releases()).toHaveLength(0);
        expect(logger.warn.mock.calls[0][0]).toMatch(
          /keeping it out of rotation/,
        );
      });

      it("keeps a server with no node", async () => {
        drainingServer();
        draining[0] = { ...draining[0], node_id: null as any };

        await sweepFor(5);

        expect(releases()).toHaveLength(0);
        expect(readNode).not.toHaveBeenCalled();
      });

      it("does not need the node when the Job shows its pods exited", async () => {
        nodeReady = "Unknown";
        jobs.set(JOB_NAME, job({ finished: true }));
        pods = [pod("Succeeded")];

        await sweep();

        expect(releases()).toHaveLength(1);
      });
    });

    describe("a lost stop", () => {
      beforeEach(() => {
        jobs.set(JOB_NAME, job());
        pods = [pod("Running")];
      });

      it("is not repeated while the normal stop can still run", async () => {
        drainingServer(NOW - 4 * MINUTE);

        await sweep();

        expect(restops()).toHaveLength(0);
        expect(releases()).toHaveLength(0);
      });

      it("is queued again, once, when the pod outlives its stop", async () => {
        drainingServer(NOW - 6 * MINUTE);

        await sweep();
        now += MINUTE;
        await sweep();

        expect(restops()).toEqual([
          [
            "StopOnDemandServer",
            { matchId: MATCH_ID },
            { removeOnComplete: true, removeOnFail: true },
          ],
        ]);
        // The server is only freed by a later sweep that sees the pod gone.
        expect(releases()).toHaveLength(0);

        pods = [pod("Succeeded")];
        jobs.set(JOB_NAME, job({ finished: true }));
        await sweep();

        expect(releases()).toHaveLength(1);
      });
    });
  });
});

describe("MatchesController.server_availability — draining servers", () => {
  const REGION = "TestA";
  let controller: any;

  const event = (
    newRow: Record<string, unknown>,
    oldRow: Record<string, unknown> = {},
  ) => ({
    op: "UPDATE",
    new: {
      enabled: true,
      connected: true,
      reserved_by_match_id: null,
      region: REGION,
      ...newRow,
    },
    old: {
      enabled: true,
      connected: true,
      region: REGION,
      ...oldRow,
    },
  });

  beforeEach(() => {
    controller = Object.create(MatchesController.prototype);
    controller.hasura = {
      query: jest.fn(async () => ({ matches: [{ id: "waiting-match" }] })),
    };
    controller.matchAssistant = { assignServer: jest.fn() };
  });

  it("does not offer a server freed by a match end while it drains", async () => {
    await controller.server_availability(
      event(
        { draining_match_id: "ended-match" },
        { reserved_by_match_id: "ended-match" },
      ),
    );

    expect(controller.matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("offers it to the waiting match once the drain clears", async () => {
    // The old pod has gone, so the row is no longer connected.
    await controller.server_availability(
      event(
        { draining_match_id: null, connected: false },
        { draining_match_id: "ended-match", connected: false },
      ),
    );

    expect(controller.matchAssistant.assignServer).toHaveBeenCalledWith(
      "waiting-match",
    );
  });

  it("still ignores a server that only disconnected", async () => {
    await controller.server_availability(
      event({ connected: false }, { connected: true }),
    );

    expect(controller.matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("does not offer a disabled server after its drain clears", async () => {
    await controller.server_availability(
      event(
        { draining_match_id: null, enabled: false },
        { draining_match_id: "ended-match" },
      ),
    );

    expect(controller.matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("offers a released server that does not drain, as before", async () => {
    await controller.server_availability(
      event({}, { reserved_by_match_id: "other-match" }),
    );

    expect(controller.matchAssistant.assignServer).toHaveBeenCalledWith(
      "waiting-match",
    );
  });

  it("counts only servers that do not drain when a node comes online", async () => {
    controller.hasura.query = jest.fn(async (request: any) =>
      request.game_server_nodes_by_pk
        ? {
            game_server_nodes_by_pk: {
              gpu: false,
              servers_aggregate: { aggregate: { count: 1 } },
            },
          }
        : { matches: [{ id: "waiting-match" }] },
    );

    await controller.node_server_availability({
      op: "UPDATE",
      new: { id: "node-1", enabled: true, status: "Online", region: REGION },
      old: { status: "Online" },
    });

    const [request] = controller.hasura.query.mock.calls[0];
    expect(
      request.game_server_nodes_by_pk.servers_aggregate.__args.where,
    ).toEqual({
      reserved_by_match_id: { _is_null: true },
      draining_match_id: { _is_null: true },
    });
    expect(controller.hasura.query.mock.calls[1][0].matches.__args.limit).toBe(
      1,
    );
  });
});
