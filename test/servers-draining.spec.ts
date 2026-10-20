const readNamespacedJob = jest.fn();
const listNamespacedPod = jest.fn();

jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {
    readNamespacedJob = readNamespacedJob;
  },
  CoreV1Api: class CoreV1Api {
    listNamespacedPod = listNamespacedPod;
  },
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
  Exec: class Exec {},
}));

import { MatchAssistantService } from "../src/matches/match-assistant/match-assistant.service";
import { MatchesController } from "../src/matches/matches.controller";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// DEAFCS: a finished match frees its on-demand server at once (tau_matches),
// but its pod keeps the node's ports for the GOTV delay and its graceful stop.
// The real triggers mark that server draining in the same write, the free
// server counts leave it out, and only the sweep, once Kubernetes shows the
// pod gone, gives it back. A new match never gets a server whose previous pod
// is still running.
describe("on-demand servers drain after their match (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let service: MatchAssistantService;
  let controller: MatchesController;
  // Pods of the match's Job, by the server they were booted on.
  let runningOn: Array<string>;

  const REGION = "TestA";
  const NODE = "drain-node-1";
  const TV_DELAY = 115;

  beforeAll(async () => {
    db = await bootMigratedDb("ServersDrainingTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199420000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, REGION);
    await postgres.query(
      `INSERT INTO game_server_nodes (id, region, enabled, enabled_for_match_making, status)
       VALUES ($1, $2, true, true, 'Online')`,
      [NODE, REGION],
    );

    service = new MatchAssistantService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      {
        has: jest.fn(async () => false),
        put: jest.fn(async () => true),
      } as any,
      {
        get: jest.fn((key: string) =>
          key === "gameServers" ? { namespace: "test" } : {},
        ),
      } as any,
      {
        query: jest.fn(async (request: any) => {
          const [row] = await postgres.query<Array<{ source: string }>>(
            "SELECT source FROM matches WHERE id = $1",
            [request.matches_by_pk.__args.id],
          );
          return { matches_by_pk: row ?? null };
        }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      postgres,
      { add: jest.fn() } as any,
    );

    const c = Object.create(MatchesController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    c.postgres = postgres;
    c.matchAssistant = { isOrganizer: jest.fn(async () => true) };
    controller = c;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    runningOn = [];
    readNamespacedJob.mockReset().mockRejectedValue({ code: 404 });
    listNamespacedPod.mockReset().mockImplementation(async () => ({
      items: runningOn.map((serverId) => ({
        spec: {
          containers: [{ env: [{ name: "SERVER_ID", value: serverId }] }],
        },
        status: { phase: "Running" },
      })),
    }));

    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL, draining_match_id = NULL, draining_check_at = NULL",
    );
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM servers WHERE game_server_node_id IS NOT NULL",
    );
  });

  let nextPort = 29000;
  const onDemandServer = async (): Promise<string> => {
    const port = nextPort;
    nextPort += 2;
    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, tv_port, enabled, connected, region,
          type, is_dedicated, game_server_node_id)
       VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, $3, true, true, $4,
               'Ranked', false, $5)
       RETURNING id::text AS id`,
      [`on-demand-${port}`, port, port + 1, REGION, NODE],
    );
    return server.id;
  };

  const dedicatedServer = async (): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT id::text FROM servers WHERE is_dedicated AND region = $1 LIMIT 1",
      [REGION],
    );
    return row.id;
  };

  // What assignOnDemandServer writes: the reservation, then server_id.
  const assign = async (matchId: string, serverId: string) => {
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
      [matchId, serverId],
    );
    await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
      matchId,
      serverId,
    ]);
  };

  const goLive = async (matchId: string) => {
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps
        WHERE NOT EXISTS (SELECT 1 FROM match_maps WHERE match_id = $1)
        ORDER BY name LIMIT 1`,
      [matchId],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      matchId,
    ]);
  };

  const liveMatchOn = async (serverId: string): Promise<string> => {
    const match = await fx.match();
    await postgres.query(
      "UPDATE match_options SET tv_delay = $2 WHERE id = $1",
      [match.options_id, TV_DELAY],
    );
    await assign(match.id, serverId);
    await goLive(match.id);
    return match.id;
  };

  const end = (matchId: string, status = "Finished") =>
    postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
      matchId,
      status,
    ]);

  // What match_events does right after a match end.
  const clearServerId = (matchId: string) =>
    postgres.query("UPDATE matches SET server_id = NULL WHERE id = $1", [
      matchId,
    ]);

  const serverRow = async (serverId: string) => {
    const [row] = await postgres.query<
      Array<{
        reserved_by_match_id: string | null;
        draining_match_id: string | null;
        check_in_s: number | null;
      }>
    >(
      `SELECT reserved_by_match_id::text, draining_match_id::text,
              round(extract(epoch FROM draining_check_at - now()))::int AS check_in_s
         FROM servers WHERE id = $1`,
      [serverId],
    );
    return row;
  };

  const freeCounts = async () => {
    const [row] = await postgres.query<Array<{ node: number; region: number }>>(
      `SELECT available_node_server_count(n) AS node,
              available_region_server_count(r) AS region
         FROM game_server_nodes n, server_regions r
        WHERE n.id = $1 AND r.value = $2`,
      [NODE, REGION],
    );
    return row;
  };

  // The servers assignOnDemandServer may pick (reserved_by_match_id and
  // notDraining; the rest of its filter is about nodes).
  const assignable = async () =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT id::text FROM servers
          WHERE type = 'Ranked' AND enabled AND NOT is_dedicated
            AND reserved_by_match_id IS NULL
            AND draining_match_id IS NULL`,
      )
    ).map(({ id }) => id);

  // The sweep, as if draining_check_at had passed.
  const sweepWhenDue = async () => {
    await postgres.query(
      "UPDATE servers SET draining_check_at = now() - interval '1 second' WHERE draining_match_id IS NOT NULL",
    );
    await service.reconcileDrainingOnDemandServers();
  };

  it("a finished match's server drains until its pod is gone", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);
    runningOn = [serverId];

    await end(matchId);
    await clearServerId(matchId);

    const row = await serverRow(serverId);
    expect(row.reserved_by_match_id).toBeNull();
    expect(row.draining_match_id).toBe(matchId);
    // Checked from the time the match-end stop runs, not before.
    expect(row.check_in_s).toBeGreaterThanOrEqual(TV_DELAY - 2);
    expect(row.check_in_s).toBeLessThanOrEqual(TV_DELAY);

    expect(await assignable()).toEqual([]);
    expect(await freeCounts()).toEqual({ node: 0, region: 1 });

    // Not due yet: the sweep leaves it.
    await service.reconcileDrainingOnDemandServers();
    expect((await serverRow(serverId)).draining_match_id).toBe(matchId);

    // Due, pod still running: stays out.
    await sweepWhenDue();
    expect(await assignable()).toEqual([]);

    // Pod gone: free again.
    runningOn = [];
    await sweepWhenDue();
    expect(await serverRow(serverId)).toEqual({
      reserved_by_match_id: null,
      draining_match_id: null,
      check_in_s: null,
    });
    expect(await assignable()).toEqual([serverId]);
    expect(await freeCounts()).toEqual({ node: 1, region: 2 });
  });

  it("a server that cannot be checked stays out", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);
    await end(matchId);
    readNamespacedJob.mockRejectedValue({ code: 500 });

    await sweepWhenDue();

    expect((await serverRow(serverId)).draining_match_id).toBe(matchId);
    expect(await assignable()).toEqual([]);
  });

  it.each(["Canceled", "Forfeit", "Tie", "Surrendered"])(
    "a %s match's server drains too",
    async (status) => {
      const serverId = await onDemandServer();
      const matchId = await liveMatchOn(serverId);

      await end(matchId, status);

      const row = await serverRow(serverId);
      expect(row.reserved_by_match_id).toBeNull();
      expect(row.draining_match_id).toBe(matchId);
      // A canceled match's server is stopped at once, so it is checked at once.
      if (status === "Canceled") {
        expect(row.check_in_s).toBeLessThanOrEqual(0);
      } else {
        expect(row.check_in_s).toBeGreaterThan(0);
      }
    },
  );

  it("a deleted match's server drains, checked at once", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);

    await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

    const row = await serverRow(serverId);
    expect(row.reserved_by_match_id).toBeNull();
    expect(row.draining_match_id).toBe(matchId);
    expect(row.check_in_s).toBeLessThanOrEqual(0);

    // Both Job names of a deleted match are checked.
    runningOn = [];
    await service.reconcileDrainingOnDemandServers();
    expect(readNamespacedJob.mock.calls.map(([r]) => r.name)).toEqual([
      `u-${matchId}`,
      `m-${matchId}`,
    ]);
    expect((await serverRow(serverId)).draining_match_id).toBeNull();
  });

  it("a dedicated server does not drain", async () => {
    const serverId = await dedicatedServer();
    const matchId = await liveMatchOn(serverId);

    await end(matchId);

    expect(await serverRow(serverId)).toEqual({
      reserved_by_match_id: null,
      draining_match_id: null,
      check_in_s: null,
    });
  });

  it("a Restore Round restart drains the old server, checked at once", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);
    runningOn = [serverId];

    // MatchRecoveryService.restartMatch (feat/match-recovery-upstream): one
    // transaction, Live -> Canceled -> WaitingForCheckIn without a server.
    await postgres.transaction(async (client) => {
      await client.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [matchId],
      );
      await client.query(
        `UPDATE matches
            SET status = 'WaitingForCheckIn', server_id = NULL, cancels_at = NULL
          WHERE id = $1`,
        [matchId],
      );
    });

    const row = await serverRow(serverId);
    expect(row.reserved_by_match_id).toBeNull();
    expect(row.draining_match_id).toBe(matchId);
    expect(row.check_in_s).toBeLessThanOrEqual(0);
    expect(await assignable()).toEqual([]);

    // Its old pod stopped (Canceled is stopped at once): free again.
    runningOn = [];
    await service.reconcileDrainingOnDemandServers();
    expect(await assignable()).toEqual([serverId]);
  });

  it("a standing Pracc server does not drain", async () => {
    // On a game node and not dedicated: only its type keeps it from draining.
    const [{ id: serverId }] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, tv_port, enabled, connected, region,
          type, is_dedicated, game_server_node_id)
       VALUES ('127.0.0.1', 'pracc', '\\x00'::bytea, 28990, 28991, true, true,
               $1, 'Practice', false, $2)
       RETURNING id::text AS id`,
      [REGION, NODE],
    );
    const matchId = await liveMatchOn(serverId);

    await end(matchId);
    expect((await serverRow(serverId)).draining_match_id).toBeNull();

    const otherMatchId = await liveMatchOn(serverId);
    await postgres.query("DELETE FROM matches WHERE id = $1", [otherMatchId]);
    expect((await serverRow(serverId)).draining_match_id).toBeNull();
  });

  it("a later update of the finished match leaves another match's server alone", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);
    await end(matchId);
    runningOn = [];
    await sweepWhenDue();
    const otherMatchId = await liveMatchOn(serverId);

    // tau_matches runs again on every update while the match is Finished.
    await postgres.query(
      "UPDATE matches SET server_id = server_id WHERE id = $1",
      [matchId],
    );

    expect(await serverRow(serverId)).toEqual({
      reserved_by_match_id: otherMatchId,
      draining_match_id: null,
      check_in_s: null,
    });
  });

  it("a server freed some other way (reboot, stop) is not marked", async () => {
    const serverId = await onDemandServer();
    const matchId = await liveMatchOn(serverId);

    // stopOnDemandServer(remove) frees the old reservation of a reboot.
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id = $1",
      [matchId],
    );

    expect((await serverRow(serverId)).draining_match_id).toBeNull();
  });

  describe("tournament reset", () => {
    const SE4 = [
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ];

    it("a reset keeps the old server draining; replay on a new server frees it", async () => {
      const t = await tfx.launch(SE4, 4);
      await tfx.playRound(t.stageIds[0], 1);
      const [final] = await postgres.query<Array<{ match_id: string }>>(
        `SELECT match_id FROM tournament_brackets
          WHERE tournament_stage_id = $1 AND round = 2`,
        [t.stageIds[0]],
      );
      const first = await onDemandServer();
      await assign(final.match_id, first);
      await goLive(final.match_id);
      await tfx.winMatch(final.match_id);
      runningOn = [first];

      await controller.ResetTournamentMatch({
        user: { steam_id: "1", role: "administrator" } as any,
        match_id: final.match_id,
      });

      // The old pod still runs out its GOTV delay.
      expect((await serverRow(first)).draining_match_id).toBe(final.match_id);
      expect(await assignable()).toEqual([]);

      // Live again on a fresh server under the same Job name; the old pod
      // went with the old Job.
      const second = await onDemandServer();
      expect(await assignable()).toEqual([second]);
      await assign(final.match_id, second);
      runningOn = [second];

      await sweepWhenDue();

      expect((await serverRow(first)).draining_match_id).toBeNull();
      expect((await serverRow(second)).reserved_by_match_id).toBe(
        final.match_id,
      );
    });
  });
});
