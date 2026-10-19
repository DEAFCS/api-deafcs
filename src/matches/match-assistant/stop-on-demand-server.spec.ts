const mockCore = {
  listNamespacedPod: jest.fn(),
  deleteNamespacedPod: jest.fn(),
};
const mockBatch = {
  deleteNamespacedJob: jest.fn(),
  readNamespacedJob: jest.fn(),
};
const mockExec = jest.fn();

jest.mock("@kubernetes/client-node", () => {
  class CoreV1Api {}
  class BatchV1Api {}
  return {
    CoreV1Api,
    BatchV1Api,
    KubeConfig: class KubeConfig {
      loadFromDefault() {}
      makeApiClient(api: unknown) {
        return api === CoreV1Api ? mockCore : mockBatch;
      }
    },
    Exec: class Exec {
      exec(...args: unknown[]) {
        return mockExec(...args);
      }
    },
  };
});

import { MatchAssistantService } from "./match-assistant.service";
import { StopOnDemandServer } from "../jobs/StopOnDemandServer";

const MATCH_ID = "f7dd654e-8849-41fc-8723-c160bca80a55";
const SERVER_ID = "ed8d788d-6ae2-4051-9dbb-ea88f7876f16";
const M_JOB = `m-${MATCH_ID}`;
const U_JOB = `u-${MATCH_ID}`;

const notFound = () => Object.assign(new Error("not found"), { code: 404 });
const conflict = () => Object.assign(new Error("conflict"), { code: 409 });

type FakePod = {
  name: string;
  phase?: string;
  running?: boolean;
  ownerUid?: string;
};

type FakeJob = {
  uid: string;
  finished?: boolean;
  pods: FakePod[];
};

describe("MatchAssistantService on-demand server stop", () => {
  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let scheduledMatchesQueue: { add: jest.Mock };
  // Live Kubernetes state, by Job name.
  let jobs: Record<string, FakeJob>;
  // Deleted Jobs whose pods are still terminating (Background propagation).
  let deleted: Set<string>;
  let match: { id: string; status: string; server_id?: string } | null;
  let servers: Array<{ id: string; reserved_by_match_id: string }>;

  const stopChecks = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === "StopOnDemandServer",
    );
  const signalledPods = () => mockExec.mock.calls.map((call) => call[1]);
  const deletedJobs = () =>
    mockBatch.deleteNamespacedJob.mock.calls.map(([args]) => args);
  const deletedPods = () =>
    mockCore.deleteNamespacedPod.mock.calls.map(([args]) => args.name);

  beforeEach(() => {
    jest.clearAllMocks();

    jobs = {};
    deleted = new Set();
    match = null;
    servers = [];

    mockBatch.readNamespacedJob.mockImplementation(async ({ name }) => {
      const job = deleted.has(name) ? undefined : jobs[name];
      if (!job) {
        throw notFound();
      }
      return {
        metadata: { name, uid: job.uid },
        status: {
          conditions: job.finished
            ? [{ type: "Complete", status: "True" }]
            : [],
        },
      };
    });
    mockBatch.deleteNamespacedJob.mockImplementation(async ({ name, body }) => {
      const job = deleted.has(name) ? undefined : jobs[name];
      if (!job) {
        throw notFound();
      }
      if (body?.preconditions?.uid && body.preconditions.uid !== job.uid) {
        throw conflict();
      }
      deleted.add(name);
      return {};
    });
    mockCore.listNamespacedPod.mockImplementation(async ({ labelSelector }) => {
      const job = jobs[labelSelector.replace("job-name=", "")];
      return {
        items: (job?.pods ?? []).map((pod) => ({
          metadata: {
            name: pod.name,
            ownerReferences: [{ uid: pod.ownerUid ?? job!.uid }],
          },
          spec: { containers: [{ name: "game-server" }] },
          status: {
            phase: pod.phase ?? "Running",
            containerStatuses: [
              {
                name: "game-server",
                state: pod.running === false ? {} : { running: {} },
              },
            ],
          },
        })),
      };
    });
    mockCore.deleteNamespacedPod.mockResolvedValue({});
    mockExec.mockResolvedValue({});

    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) => {
        if ("matches_by_pk" in query) {
          return { matches_by_pk: match };
        }
        if ("matches" in query) {
          return { matches: match ? [match] : [] };
        }
        if ("servers" in query) {
          return { servers };
        }
        return {};
      }),
      mutation: jest.fn().mockResolvedValue({}),
    };
    scheduledMatchesQueue = { add: jest.fn().mockResolvedValue({}) };

    service = new MatchAssistantService(
      {
        warn: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        verbose: jest.fn(),
      } as any,
      {} as any,
      {} as any,
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
      {} as any,
      scheduledMatchesQueue as any,
    );
  });

  describe("stopOnDemandServer (graceful)", () => {
    it("signals the m- server of a deleted match and queues a stop check", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([`${M_JOB}-djp95`]);
      expect(mockExec.mock.calls[0][3]).toEqual(["kill", "-SIGUSR1", "1"]);
      expect(stopChecks()).toEqual([
        [
          "StopOnDemandServer",
          { matchId: MATCH_ID, jobName: M_JOB, jobUid: "uid-m" },
          expect.objectContaining({
            delay: MatchAssistantService.ON_DEMAND_SERVER_STOP_CHECK_DELAY_MS,
            jobId: `match.${MATCH_ID}.server-stop-check.uid-m`,
          }),
        ],
      ]);
      expect(deletedJobs()).toEqual([]);
      // A graceful stop leaves the server row to the server going offline.
      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("only looks at the m- Job of an existing match", async () => {
      match = { id: MATCH_ID, status: "Finished" };
      jobs[U_JOB] = { uid: "uid-u", pods: [{ name: `${U_JOB}-x` }] };
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([`${M_JOB}-djp95`]);
    });

    it("signals a Pracc server under its u- Job", async () => {
      match = { id: MATCH_ID, status: "Canceled" };
      (match as any).source = "practice";
      jobs[U_JOB] = { uid: "uid-u", pods: [{ name: `${U_JOB}-fs4kz` }] };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([`${U_JOB}-fs4kz`]);
      expect(stopChecks()[0][1]).toEqual({
        matchId: MATCH_ID,
        jobName: U_JOB,
        jobUid: "uid-u",
      });
    });

    it("leaves a Job that already finished alone", async () => {
      jobs[M_JOB] = {
        uid: "uid-m",
        finished: true,
        pods: [{ name: `${M_JOB}-done`, phase: "Succeeded", running: false }],
      };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([]);
      expect(stopChecks()).toEqual([]);
      expect(deletedJobs()).toEqual([]);
    });

    it("leaves a pod that already exited cleanly alone", async () => {
      jobs[M_JOB] = {
        uid: "uid-m",
        pods: [{ name: `${M_JOB}-done`, phase: "Succeeded", running: false }],
      };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([]);
      expect(deletedJobs()).toEqual([]);
    });

    it("removes a Job whose server never started instead of signalling it", async () => {
      jobs[M_JOB] = {
        uid: "uid-m",
        pods: [{ name: `${M_JOB}-pending`, phase: "Pending", running: false }],
      };

      await service.stopOnDemandServer(MATCH_ID);

      expect(signalledPods()).toEqual([]);
      expect(deletedJobs()).toEqual([
        expect.objectContaining({
          name: M_JOB,
          body: expect.objectContaining({
            propagationPolicy: "Background",
            preconditions: { uid: "uid-m" },
          }),
        }),
      ]);
      expect(deletedPods()).toEqual([`${M_JOB}-pending`]);
      expect(stopChecks()).toEqual([]);
    });
  });

  describe("stopOnDemandServer (remove)", () => {
    it("removes both candidate Jobs of a deleted match and frees the server", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };

      await service.stopOnDemandServer(MATCH_ID, true);

      expect(deletedJobs().map((args) => args.name)).toEqual([U_JOB, M_JOB]);
      expect(deletedPods()).toEqual([`${M_JOB}-djp95`]);
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_servers: expect.objectContaining({
            __args: expect.objectContaining({
              where: { reserved_by_match_id: { _eq: MATCH_ID } },
            }),
          }),
        }),
      );
    });
  });

  describe("removeUnstoppedOnDemandServer (stop check)", () => {
    it("removes a deleted match's server that ignored the signal", async () => {
      jobs[M_JOB] = {
        uid: "uid-m",
        pods: [
          { name: `${M_JOB}-djp95` },
          { name: `${M_JOB}-other`, ownerUid: "uid-someone-else" },
        ],
      };

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs()).toEqual([
        expect.objectContaining({
          name: M_JOB,
          body: expect.objectContaining({ preconditions: { uid: "uid-m" } }),
        }),
      ]);
      expect(deletedPods()).toEqual([`${M_JOB}-djp95`]);
    });

    it("does nothing once the server stopped on its own", async () => {
      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs()).toEqual([]);
    });

    it("does nothing when the Job finished", async () => {
      jobs[M_JOB] = { uid: "uid-m", finished: true, pods: [] };

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs()).toEqual([]);
    });

    it("leaves a new server under the same name alone", async () => {
      jobs[M_JOB] = { uid: "uid-new", pods: [{ name: `${M_JOB}-new` }] };

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs()).toEqual([]);
      expect(deletedPods()).toEqual([]);
    });

    it("leaves the server of a match that is running again", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };
      match = { id: MATCH_ID, status: "Live", server_id: SERVER_ID };
      servers = [{ id: SERVER_ID, reserved_by_match_id: MATCH_ID }];

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs()).toEqual([]);
    });

    it("removes the server of a finished match that still holds the row", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };
      match = { id: MATCH_ID, status: "Finished", server_id: SERVER_ID };
      servers = [{ id: SERVER_ID, reserved_by_match_id: MATCH_ID }];

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB);

      expect(deletedJobs().map((args) => args.name)).toEqual([M_JOB]);
    });

    it("treats a Job replaced mid-delete (409) as not removed", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [] };
      mockBatch.deleteNamespacedJob.mockRejectedValueOnce(conflict());

      await expect(
        service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m", M_JOB),
      ).resolves.toBeUndefined();
    });

    it("defaults to the m- name for a check queued without one", async () => {
      jobs[M_JOB] = { uid: "uid-m", pods: [] };

      await service.removeUnstoppedOnDemandServer(MATCH_ID, "uid-m");

      expect(deletedJobs().map((args) => args.name)).toEqual([M_JOB]);
    });
  });

  describe("stopEndedMatchServer (delayed stop)", () => {
    beforeEach(() => {
      jobs[M_JOB] = { uid: "uid-m", pods: [{ name: `${M_JOB}-djp95` }] };
    });

    it("leaves the server of a match that was started again", async () => {
      match = { id: MATCH_ID, status: "Live", server_id: SERVER_ID };

      await service.stopEndedMatchServer(MATCH_ID);

      expect(signalledPods()).toEqual([]);
      expect(mockCore.listNamespacedPod).not.toHaveBeenCalled();
    });

    it.each(["Finished", "Canceled", "Forfeit", "Tie", "Surrendered"])(
      "stops the server of a %s match",
      async (status) => {
        match = { id: MATCH_ID, status };

        await service.stopEndedMatchServer(MATCH_ID);

        expect(signalledPods()).toEqual([`${M_JOB}-djp95`]);
      },
    );

    it("stops the server of a deleted match", async () => {
      await service.stopEndedMatchServer(MATCH_ID);

      expect(signalledPods()).toEqual([`${M_JOB}-djp95`]);
    });
  });

  describe("StopOnDemandServer job", () => {
    it("routes a stop check to removeUnstoppedOnDemandServer", async () => {
      const assistant = {
        removeUnstoppedOnDemandServer: jest.fn(),
        stopEndedMatchServer: jest.fn(),
      };

      await new StopOnDemandServer(assistant as any).process({
        data: { matchId: MATCH_ID, jobName: U_JOB, jobUid: "uid-u" },
      } as any);

      expect(assistant.removeUnstoppedOnDemandServer).toHaveBeenCalledWith(
        MATCH_ID,
        "uid-u",
        U_JOB,
      );
      expect(assistant.stopEndedMatchServer).not.toHaveBeenCalled();
    });

    it("routes a match-end stop through the restart guard", async () => {
      const assistant = {
        removeUnstoppedOnDemandServer: jest.fn(),
        stopEndedMatchServer: jest.fn(),
      };

      await new StopOnDemandServer(assistant as any).process({
        data: { matchId: MATCH_ID },
      } as any);

      expect(assistant.stopEndedMatchServer).toHaveBeenCalledWith(MATCH_ID);
      expect(assistant.removeUnstoppedOnDemandServer).not.toHaveBeenCalled();
    });
  });
});
