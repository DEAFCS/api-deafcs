jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";
import { StopOnDemandServer } from "./jobs/StopOnDemandServer";

const MATCH_ID = "3dce797e-7c1b-4f61-9d0e-5b0a3c6f2a11";
const OLD_SERVER_ID = "6f1f3b8e-2c4d-4a5e-9f60-7a8b9c0d1e2f";
const SERVER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// The events a tournament reset produces, and the Live transition after it.
describe("MatchesController after a tournament reset", () => {
  let controller: MatchesController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let matchAssistant: {
    isOrganizer: jest.Mock;
    stopOnDemandServer: jest.Mock;
    assignServer: jest.Mock;
    reserveDedicatedServer: jest.Mock;
  };
  let scheduledMatchesQueue: { add: jest.Mock };
  let server: {
    id: string;
    is_dedicated: boolean;
    reserved_by_match_id: string | null;
    game_server_node_id: string | null;
  } | null;

  beforeEach(() => {
    server = null;

    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) => {
        if ("matches_by_pk" in query) {
          return {
            matches_by_pk: {
              id: MATCH_ID,
              options: { prefer_dedicated_server: false },
              server,
            },
          };
        }
        return {};
      }),
      mutation: jest.fn().mockResolvedValue({}),
    };
    postgres = {
      query: jest.fn(async (sql: string) =>
        sql.includes("preview_tournament_match_reset")
          ? [{ will_delete_match: false, match_status: "Finished" }]
          : [],
      ),
    };
    matchAssistant = {
      isOrganizer: jest.fn(async () => true),
      stopOnDemandServer: jest.fn().mockResolvedValue(undefined),
      assignServer: jest.fn().mockResolvedValue(undefined),
      reserveDedicatedServer: jest.fn().mockResolvedValue(undefined),
    };
    scheduledMatchesQueue = { add: jest.fn().mockResolvedValue({}) };

    controller = new MatchesController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      postgres as any,
      { get: jest.fn(() => ({})) } as any,
      {} as any,
      matchAssistant as any,
      {} as any,
      { updateMatchOverview: jest.fn() } as any,
      {} as any,
      { sendMatchWaitingForServerNotification: jest.fn() } as any,
      {} as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn().mockResolvedValue({}) } as any,
      scheduledMatchesQueue as any,
      {} as any,
      {} as any,
      {
        createMatchVoiceChannels: jest.fn(),
        movePlayersToMatchChannels: jest.fn(),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { evictForMatch: jest.fn().mockResolvedValue(undefined) } as any,
    );

    jest
      .spyOn(controller as any, "generateCameraTokensIfRequired")
      .mockResolvedValue(undefined);
  });

  const updated = (
    old: Record<string, unknown>,
    next: Record<string, unknown>,
  ) =>
    controller.match_events({
      op: "UPDATE",
      old: { id: MATCH_ID, source: "5stack", ...old },
      new: { id: MATCH_ID, source: "5stack", ...old, ...next },
    } as any);

  describe("ResetTournamentMatch", () => {
    const sql = () => postgres.query.mock.calls.map(([query]) => query);

    it("drops the old server_id right after the bracket reset", async () => {
      await controller.ResetTournamentMatch({
        user: { steam_id: "1" } as any,
        match_id: MATCH_ID,
      });

      const statements = sql();
      const reset = statements.findIndex((query) =>
        query.includes("reset_tournament_match("),
      );
      const clear = statements.findIndex((query) =>
        query.includes("SET server_id = NULL"),
      );

      expect(reset).toBeGreaterThan(-1);
      expect(clear).toBeGreaterThan(reset);
      // Only a match back before Live, never a Live or Finished one.
      expect(statements[clear]).toMatch(
        /status IN \('Scheduled', 'WaitingForCheckIn'\)/,
      );
      expect(postgres.query.mock.calls[clear][1]).toEqual([MATCH_ID]);
    });

    it("changes nothing when the reset itself is refused", async () => {
      postgres.query.mockImplementation(async (query: string) => {
        if (query.includes("preview_tournament_match_reset")) {
          return [{ will_delete_match: false, match_status: "Finished" }];
        }
        if (query.includes("reset_tournament_match(")) {
          throw new Error("cannot reset a live match");
        }
        return [];
      });

      await expect(
        controller.ResetTournamentMatch({
          user: { steam_id: "1" } as any,
          match_id: MATCH_ID,
        }),
      ).rejects.toThrow("cannot reset a live match");

      expect(sql().some((query) => query.includes("SET server_id"))).toBe(
        false,
      );
    });

    it("refuses a non-organizer before touching anything", async () => {
      matchAssistant.isOrganizer.mockResolvedValue(false);

      await expect(
        controller.ResetTournamentMatch({
          user: { steam_id: "1" } as any,
          match_id: MATCH_ID,
        }),
      ).rejects.toThrow("you are not a tournament organizer");

      expect(postgres.query).not.toHaveBeenCalled();
    });
  });

  describe("match_events", () => {
    it("stops the old server when the reset drops a stale server_id", async () => {
      await updated(
        { status: "WaitingForCheckIn", server_id: OLD_SERVER_ID },
        { server_id: null },
      );

      expect(matchAssistant.stopOnDemandServer).toHaveBeenCalledWith(MATCH_ID);
      expect(matchAssistant.assignServer).not.toHaveBeenCalled();
      // No match-end handling for a match that is starting over.
      expect(scheduledMatchesQueue.add).not.toHaveBeenCalled();
    });

    it("keeps the GOTV delay: only the match end's delayed stop is queued", async () => {
      hasura.query.mockImplementation(
        async (query: Record<string, unknown>) => {
          if ("servers_by_pk" in query) {
            return { servers_by_pk: { is_dedicated: false } };
          }
          if ("match_options_by_pk" in query) {
            return { match_options_by_pk: { tv_delay: 115 } };
          }
          return {};
        },
      );
      jest
        .spyOn(controller as any, "removeDiscordIntegration")
        .mockResolvedValue(undefined);
      jest
        .spyOn(controller as any, "releaseScrimScheduledNotifications")
        .mockResolvedValue(undefined);
      (controller as any).matchmaking = {
        cancelMatchMakingByMatchId: jest.fn(),
      };
      (controller as any).matchRelayService = { removeBroadcast: jest.fn() };
      (controller as any).gameStreamer = { stopLiveIfRunning: jest.fn() };
      (controller as any).steamBansQueue = {
        add: jest.fn().mockResolvedValue({}),
      };
      (controller as any).clips = { resumeAllPausedBatches: jest.fn() };
      (controller as any).handleGpuFreed = jest.fn();

      // The match ends on its server...
      await updated(
        { status: "Live", server_id: SERVER_ID, match_options_id: "options-1" },
        { status: "Finished" },
      );
      // ...and is reset inside the GOTV delay, after server_id was cleared.
      await updated(
        { status: "Finished", server_id: null },
        { status: "WaitingForCheckIn" },
      ).catch((): void => undefined);

      expect(
        scheduledMatchesQueue.add.mock.calls.filter(
          ([name]) => name === StopOnDemandServer.name,
        ),
      ).toEqual([
        [StopOnDemandServer.name, { matchId: MATCH_ID }, { delay: 115_000 }],
      ]);
      expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
    });

    it("queues no stop of its own for the reset status change", async () => {
      await updated(
        { status: "Finished", server_id: null },
        { status: "WaitingForCheckIn" },
      );

      expect(
        scheduledMatchesQueue.add.mock.calls.filter(
          ([name]) => name === StopOnDemandServer.name,
        ),
      ).toHaveLength(0);
      expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
      expect(matchAssistant.assignServer).not.toHaveBeenCalled();
    });

    it.each(["WaitingForCheckIn", "Veto", "Scheduled"])(
      "assigns a fresh server when the reset match goes Live from %s",
      async (from) => {
        await updated({ status: from, server_id: null }, { status: "Live" });

        expect(matchAssistant.assignServer).toHaveBeenCalledWith(MATCH_ID);
      },
    );

    it("leaves a Live match on the server it holds", async () => {
      server = {
        id: SERVER_ID,
        is_dedicated: false,
        reserved_by_match_id: MATCH_ID,
        game_server_node_id: null,
      };

      await updated(
        { status: "Live", server_id: SERVER_ID },
        { status: "Live" },
      );

      expect(matchAssistant.assignServer).not.toHaveBeenCalled();
      expect(matchAssistant.stopOnDemandServer).not.toHaveBeenCalled();
    });

    it("still reserves a dedicated server picked for the match", async () => {
      server = {
        id: SERVER_ID,
        is_dedicated: true,
        reserved_by_match_id: null,
        game_server_node_id: null,
      };

      await updated(
        { status: "WaitingForCheckIn", server_id: SERVER_ID },
        { status: "Live" },
      );

      expect(matchAssistant.reserveDedicatedServer).toHaveBeenCalledWith(
        MATCH_ID,
      );
      expect(matchAssistant.assignServer).not.toHaveBeenCalled();
    });
  });
});
