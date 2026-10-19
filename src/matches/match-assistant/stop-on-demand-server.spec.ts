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

const MATCH_ID = "f7dd654e-8849-41fc-8723-c160bca80a55";

const notFound = () => Object.assign(new Error("not found"), { code: 404 });

describe("MatchAssistantService.stopOnDemandServer", () => {
  let service: MatchAssistantService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  // job name -> pod names still running under it
  let pods: Record<string, string[]>;

  const selectors = () =>
    mockCore.listNamespacedPod.mock.calls.map(([args]) => args.labelSelector);

  const matchRow = (row: { source?: string } | null) => {
    hasura.query.mockImplementation(async (query: Record<string, unknown>) => {
      if ("matches_by_pk" in query) {
        return { matches_by_pk: row };
      }
      return {};
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();

    pods = {};
    mockCore.listNamespacedPod.mockImplementation(async ({ labelSelector }) => {
      const jobName = labelSelector.replace("job-name=", "");
      return {
        items: (pods[jobName] ?? []).map((name) => ({
          metadata: { name },
          spec: { containers: [{ name: "game-server" }] },
        })),
      };
    });
    mockCore.deleteNamespacedPod.mockResolvedValue({});
    mockBatch.deleteNamespacedJob.mockResolvedValue({});
    mockBatch.readNamespacedJob.mockRejectedValue(notFound());
    mockExec.mockResolvedValue({});

    hasura = {
      query: jest.fn(),
      mutation: jest.fn().mockResolvedValue({}),
    };

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
    );
  });

  it("signals the m- server of a deleted match (the delayed stop after a delete)", async () => {
    matchRow(null);
    pods[`m-${MATCH_ID}`] = [`m-${MATCH_ID}-djp95`];

    await service.stopOnDemandServer(MATCH_ID);

    expect(selectors()).toEqual([
      `job-name=u-${MATCH_ID}`,
      `job-name=m-${MATCH_ID}`,
    ]);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][1]).toBe(`m-${MATCH_ID}-djp95`);
    expect(mockExec.mock.calls[0][3]).toEqual(["kill", "-SIGUSR1", "1"]);
    expect(mockBatch.deleteNamespacedJob).not.toHaveBeenCalled();
    // A graceful stop leaves the server row to the server going offline.
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("removes both candidate Jobs of a deleted match when asked to remove", async () => {
    matchRow(null);
    pods[`m-${MATCH_ID}`] = [`m-${MATCH_ID}-djp95`];

    await service.stopOnDemandServer(MATCH_ID, true);

    expect(mockCore.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: `m-${MATCH_ID}-djp95` }),
    );
    expect(
      mockBatch.deleteNamespacedJob.mock.calls.map(([args]) => args.name),
    ).toEqual([`u-${MATCH_ID}`, `m-${MATCH_ID}`]);
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

  it("keeps going when a candidate Job is already gone", async () => {
    matchRow(null);
    pods[`m-${MATCH_ID}`] = [`m-${MATCH_ID}-djp95`];
    mockBatch.deleteNamespacedJob.mockImplementation(async ({ name }) => {
      if (name.startsWith("u-")) {
        throw notFound();
      }
      return {};
    });

    await service.stopOnDemandServer(MATCH_ID, true);

    expect(mockBatch.deleteNamespacedJob).toHaveBeenCalledTimes(2);
    expect(mockCore.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("only touches the m- Job of an existing match", async () => {
    matchRow({ source: "5stack" });
    pods[`m-${MATCH_ID}`] = [`m-${MATCH_ID}-djp95`];

    await service.stopOnDemandServer(MATCH_ID);

    expect(selectors()).toEqual([`job-name=m-${MATCH_ID}`]);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("signals a Pracc server under its u- Job", async () => {
    matchRow({ source: "practice" });
    pods[`u-${MATCH_ID}`] = [`u-${MATCH_ID}-fs4kz`];

    await service.stopOnDemandServer(MATCH_ID);

    expect(selectors()).toEqual([
      `job-name=u-${MATCH_ID}`,
      `job-name=m-${MATCH_ID}`,
    ]);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][1]).toBe(`u-${MATCH_ID}-fs4kz`);
  });
});
