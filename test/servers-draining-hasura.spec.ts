import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createClient } from "../generated";
import { MatchAssistantService } from "../src/matches/match-assistant/match-assistant.service";
import { MatchesController } from "../src/matches/matches.controller";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS: the draining marker through a real Hasura with this branch's
// metadata (same engine version as production): the metadata is consistent,
// the API's GraphQL filters on draining_match_id work, and server_availability
// is fired with the marker both when a match end sets it and when it clears.
describe("draining on-demand servers (Hasura)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let hook: http.Server;
  let client: ReturnType<typeof createClient>;
  const events: Array<any> = [];

  const adminSecret = "servers-draining-hasura-test";
  const REGION = "TestA";
  const NODE = "drain-hasura-node";

  const metadata = async (body: Record<string, unknown>) => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify(body),
    });
    return response.json();
  };

  const onDemandServer = async (port: number): Promise<string> => {
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

  const availabilityEvent = async (
    predicate: (data: { old: any; new: any }) => boolean,
  ) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const found = events.find(
        (event) =>
          event.trigger?.name === "server_availability" &&
          predicate(event.event.data),
      );
      if (found) {
        return found.event.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("no matching server_availability event");
  };

  beforeAll(async () => {
    db = await bootContainerAndMigrate("ServersDrainingHasuraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199967000000n);

    hook = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        try {
          events.push(JSON.parse(body));
        } catch {
          // ignore
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as AddressInfo).port;

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: `http://host.docker.internal:${hookPort}`,
        HASURA_GRAPHQL_EVENT_HOOK: `http://host.docker.internal:${hookPort}`,
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("./hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();

    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
    client = createClient({
      url: `${endpoint}/v1/graphql`,
      headers: { "x-hasura-admin-secret": adminSecret },
    });

    await fx.region(REGION);
    await postgres.query(
      `INSERT INTO game_server_nodes (id, region, enabled, enabled_for_match_making, status)
       VALUES ($1, $2, true, true, 'Online')`,
      [NODE, REGION],
    );
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
    await new Promise((resolve) => hook?.close(resolve));
  });

  it("the metadata is consistent and server_availability watches the marker", async () => {
    expect(
      await metadata({ type: "get_inconsistent_metadata", args: {} }),
    ).toMatchObject({ is_consistent: true });

    const exported = await metadata({ type: "export_metadata", args: {} });
    const servers = exported.sources
      .find((source: any) => source.name === "default")
      .tables.find((table: any) => table.table.name === "servers");
    const trigger = servers.event_triggers.find(
      (event: any) => event.name === "server_availability",
    );

    expect(trigger.definition.update.columns).toContain("draining_match_id");
  });

  it("the API's free-server count and node count leave a draining server out", async () => {
    const free = await onDemandServer(31000);
    const draining = await onDemandServer(31002);
    const { matchId } = await fx.bareMatch();
    await postgres.query(
      "UPDATE servers SET draining_match_id = $1, draining_check_at = now() WHERE id = $2",
      [matchId, draining],
    );

    const service = new MatchAssistantService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      {} as any,
      {
        get: jest.fn((key: string) =>
          key === "gameServers" ? { namespace: "test" } : {},
        ),
      } as any,
      client as any,
      {} as any,
      {} as any,
      {} as any,
      { add: jest.fn() } as any,
      postgres,
      { add: jest.fn() } as any,
    );

    expect(await service.countFreeOnDemandServers(REGION)).toBe(1);

    const controller = Object.create(MatchesController.prototype) as any;
    controller.hasura = client;
    controller.matchAssistant = { assignServer: jest.fn() };
    controller.clips = { reconcileQueuedHighlights: jest.fn(async () => {}) };
    await controller.node_server_availability({
      op: "UPDATE",
      new: { id: NODE, enabled: true, status: "Online", region: REGION },
      old: { status: "Online" },
    });
    // One free server, one waiting match fetched at most: none are waiting.
    expect(controller.matchAssistant.assignServer).not.toHaveBeenCalled();

    await postgres.query(
      "UPDATE servers SET enabled = false WHERE id IN ($1, $2)",
      [free, draining],
    );
  });

  it("fires server_availability with the marker when a match ends and when it clears", async () => {
    const serverId = await onDemandServer(31004);
    const match = await fx.match();
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps
        WHERE NOT EXISTS (SELECT 1 FROM match_maps WHERE match_id = $1)
        ORDER BY name LIMIT 1`,
      [match.id],
    );
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
      [match.id, serverId],
    );
    await postgres.query(
      "UPDATE matches SET server_id = $2, status = 'Live' WHERE id = $1",
      [match.id, serverId],
    );
    await postgres.query(
      "UPDATE matches SET status = 'Finished' WHERE id = $1",
      [match.id],
    );

    const ended = await availabilityEvent(
      (data) => data.new?.id === serverId && !!data.new.draining_match_id,
    );
    expect(ended.old.reserved_by_match_id).toBe(match.id);
    expect(ended.new.reserved_by_match_id).toBeNull();
    expect(ended.new.draining_match_id).toBe(match.id);

    // The sweep's write once the old pod is gone (it also disconnected).
    await postgres.query("UPDATE servers SET connected = false WHERE id = $1", [
      serverId,
    ]);
    await postgres.query(
      `UPDATE public.servers
          SET draining_match_id = NULL, draining_check_at = NULL
        WHERE id = $1::uuid AND draining_match_id = $2::uuid`,
      [serverId, match.id],
    );

    const cleared = await availabilityEvent(
      (data) =>
        data.new?.id === serverId &&
        !!data.old?.draining_match_id &&
        !data.new.draining_match_id,
    );

    // What MatchesController.server_availability does with each event.
    const controller = Object.create(MatchesController.prototype) as any;
    controller.hasura = {
      query: jest.fn(async () => ({ matches: [{ id: "waiting-match" }] })),
    };
    controller.matchAssistant = { assignServer: jest.fn() };

    await controller.server_availability(ended);
    expect(controller.matchAssistant.assignServer).not.toHaveBeenCalled();

    await controller.server_availability(cleared);
    expect(controller.matchAssistant.assignServer).toHaveBeenCalledWith(
      "waiting-match",
    );
  });
});
