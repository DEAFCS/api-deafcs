import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Fixtures } from "./utils/fixtures";
import {
  bootContainerAndMigrate,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The Pracc panel's staff console reads the server a session runs on through
// utility_practice_sessions.server_id. The website asks for it in the one
// session document every member subscribes to, so it must resolve -- as null
// -- for an ordinary player too: a field the role may not select would fail
// the whole subscription, not just the console. Run on the production engine
// with this repo's metadata.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";

const sessionQuery = `query ($id: uuid!) {
  utility_practice_sessions_by_pk(id: $id) {
    id
    match_id
    server_id
    match { server_id }
  }
}`;

describe("practice session server id through Hasura", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let hostSteamId: string;
  let sessionId: string;
  let serverId: string;
  const adminSecret = "practice-server-id-local-test";

  async function gql(
    role: string,
    userId: string,
    variables: Record<string, unknown>,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": role,
        "x-hasura-user-id": userId,
      },
      body: JSON.stringify({ query: sessionQuery, variables }),
    });
    return (await response.json()) as { data?: any; errors?: any[] };
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("PracticeServerIdHasura");
    const postgres = db.postgres;
    const fx = new Fixtures(postgres, 76561199710000000n);

    await seedRegionWithServer(postgres, "TestA");
    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, enabled, connected, region, type, is_dedicated)
       VALUES ('127.0.0.1', 'practice-1', '\\x00'::bytea, 27960, true, true, 'TestA', 'Practice', true)
       RETURNING id::text AS id`,
    );
    serverId = server.id;

    const { matchId } = await fx.bareMatch();
    await postgres.query(
      "UPDATE matches SET server_id = $2::uuid, source = 'practice' WHERE id = $1::uuid",
      [matchId, serverId],
    );

    hostSteamId = await fx.player();
    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, status, match_id)
       VALUES ($1::bigint, 'de_mirage', 'TestA', 'Ready', $2::uuid)
       RETURNING id::text AS id`,
      [hostSteamId, matchId],
    );
    sessionId = session.id;

    const c = db.container!;
    const databaseUrl = `postgres://${c.getUsername()}:${c.getPassword()}@host.docker.internal:${c.getPort()}/${c.getDatabase()}`;
    hasura = await new GenericContainer(HASURA_IMAGE)
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .withStartupTimeout(240_000)
      .start();
    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  it("loads the full metadata consistently", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    expect(await response.json()).toMatchObject({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("gives an administrator the server, which match { server_id } never did", async () => {
    const result = await gql("administrator", hostSteamId, { id: sessionId });

    expect(result.errors).toBeUndefined();
    expect(result.data.utility_practice_sessions_by_pk.server_id).toBe(
      serverId,
    );
    // The bug: practice matches are filtered out of matches for every role.
    expect(result.data.utility_practice_sessions_by_pk.match).toBeNull();
  });

  it("answers null, not an error, to the player hosting the session", async () => {
    const result = await gql("user", hostSteamId, { id: sessionId });

    expect(result.errors).toBeUndefined();
    expect(result.data.utility_practice_sessions_by_pk.id).toBe(sessionId);
    expect(result.data.utility_practice_sessions_by_pk.server_id).toBeNull();
  });

  it("answers null to a moderator, who cannot open RCON on it", async () => {
    const result = await gql("moderator", hostSteamId, { id: sessionId });

    expect(result.errors).toBeUndefined();
    expect(result.data.utility_practice_sessions_by_pk.server_id).toBeNull();
  });
});
