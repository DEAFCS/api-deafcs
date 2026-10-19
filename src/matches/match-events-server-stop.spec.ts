jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";
import { StopOnDemandServer } from "./jobs/StopOnDemandServer";

const MATCH_ID = "d9745596-1066-49d9-a896-483244aa5b90";
const SERVER_ID = "2bfe58d6-0d8b-4e21-8500-50160a5a5e56";

describe("MatchesController.match_events stops the match server", () => {
  let controller: MatchesController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let scheduledMatchesQueue: { add: jest.Mock };
  let utilityPractice: { markEndedForMatch: jest.Mock };
  let isDedicated: boolean;

  const stopCalls = () =>
    scheduledMatchesQueue.add.mock.calls.filter(
      ([name]) => name === StopOnDemandServer.name,
    );

  const queried = (key: string) =>
    hasura.query.mock.calls.some(([query]) => key in query);

  const clearedServerId = () =>
    hasura.mutation.mock.calls.some(
      ([mutation]) =>
        mutation.update_matches_by_pk?.__args?._set?.server_id === null,
    );

  beforeEach(() => {
    isDedicated = false;

    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) => {
        if ("servers_by_pk" in query) {
          return { servers_by_pk: { is_dedicated: isDedicated } };
        }
        if ("match_options_by_pk" in query) {
          return { match_options_by_pk: { tv_delay: 115 } };
        }
        return {};
      }),
      mutation: jest.fn().mockResolvedValue({}),
    };
    scheduledMatchesQueue = { add: jest.fn().mockResolvedValue({}) };
    utilityPractice = { markEndedForMatch: jest.fn().mockResolvedValue({}) };

    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      verbose: jest.fn(),
    };

    controller = new MatchesController(
      logger as any,
      hasura as any,
      {} as any,
      { get: jest.fn(() => ({})) } as any,
      { cancelMatchMakingByMatchId: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { removeLobby: jest.fn() } as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn().mockResolvedValue({}) } as any,
      scheduledMatchesQueue as any,
      {} as any,
      { removeBroadcast: jest.fn() } as any,
      {} as any,
      {
        stopLive: jest.fn(),
        stopLiveIfRunning: jest.fn(),
        promotePendingLiveStreams: jest.fn(async () => ({
          promoted: [] as string[],
        })),
      } as any,
      {} as any,
      { resumeAllPausedBatches: jest.fn() } as any,
      {} as any,
      {} as any,
      utilityPractice as any,
    );

    jest
      .spyOn(controller as any, "removeDiscordIntegration")
      .mockResolvedValue(undefined);
    jest
      .spyOn(controller as any, "releaseScrimScheduledNotifications")
      .mockResolvedValue(undefined);
  });

  const deleted = (old: Record<string, unknown>) =>
    controller.match_events({
      op: "DELETE",
      old: { id: MATCH_ID, source: "5stack", status: "Live", ...old },
      new: {},
    } as any);

  const updated = (
    old: Record<string, unknown>,
    next: Record<string, unknown>,
  ) =>
    controller.match_events({
      op: "UPDATE",
      old: { id: MATCH_ID, source: "5stack", ...old },
      new: { id: MATCH_ID, source: "5stack", ...old, ...next },
    } as any);

  it("queues an immediate stop for a deleted match, using the old server_id", async () => {
    await deleted({ server_id: SERVER_ID, match_options_id: "options-1" });

    expect(stopCalls()).toEqual([
      [StopOnDemandServer.name, { matchId: MATCH_ID }, undefined],
    ]);
    // No GOTV delay for a delete, and no write to a row that is gone.
    expect(queried("match_options_by_pk")).toBe(false);
    expect(clearedServerId()).toBe(false);
  });

  it("still queues the stop when a later match-end side effect throws", async () => {
    jest
      .spyOn(controller as any, "removeDiscordIntegration")
      .mockRejectedValue(new Error("discord down"));

    await expect(deleted({ server_id: SERVER_ID })).rejects.toThrow(
      "discord down",
    );

    expect(stopCalls()).toHaveLength(1);
  });

  it("queues nothing for a deleted match that never had a server", async () => {
    await deleted({ server_id: null });

    expect(stopCalls()).toHaveLength(0);
  });

  it("leaves a dedicated server running when its match is deleted", async () => {
    isDedicated = true;

    await deleted({ server_id: SERVER_ID });

    expect(stopCalls()).toHaveLength(0);
  });

  it("delays the stop of a finished match by its tv_delay and frees server_id", async () => {
    await updated(
      { status: "Live", server_id: SERVER_ID, match_options_id: "options-1" },
      { status: "Finished" },
    );

    expect(stopCalls()).toEqual([
      [StopOnDemandServer.name, { matchId: MATCH_ID }, { delay: 115_000 }],
    ]);
    expect(clearedServerId()).toBe(true);
  });

  it("stops a canceled match's server without a delay", async () => {
    await updated(
      { status: "Live", server_id: SERVER_ID, match_options_id: "options-1" },
      { status: "Canceled" },
    );

    expect(stopCalls()).toEqual([
      [StopOnDemandServer.name, { matchId: MATCH_ID }, undefined],
    ]);
    expect(queried("match_options_by_pk")).toBe(false);
  });

  it("queues no stop while a match is still running", async () => {
    await updated(
      { status: "Live", server_id: SERVER_ID },
      { status: "Live", region: undefined },
    ).catch((): void => undefined);

    expect(stopCalls()).toHaveLength(0);
  });

  it("stops a deleted Pracc session's server", async () => {
    await controller.match_events({
      op: "DELETE",
      old: { id: MATCH_ID, source: "practice", server_id: SERVER_ID },
      new: {},
    } as any);

    expect(stopCalls()).toEqual([
      [StopOnDemandServer.name, { matchId: MATCH_ID }],
    ]);
    expect(utilityPractice.markEndedForMatch).toHaveBeenCalledWith(MATCH_ID);
  });
});
