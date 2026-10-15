import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// The replay viewer reads map callouts and the demo's parser/playback
// versions through Hasura. These are the WEB documents as the regenerated
// zeus client prints them, run on the production engine with this repo's
// metadata, so a permission or schema mismatch fails here rather than as a
// global error toast on the match replay.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";

const calloutsQuery = `query ($mapName: String!) {
  map_callouts(where: {map_name: {_eq: $mapName}}, order_by: [{name: asc}]) {
    map_name
    name
    boxes
    source
  }
}`;

describe("map callouts and demo versions through Hasura", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  const adminSecret = "map-callouts-local-test";

  async function gql(
    query: string,
    role?: string,
    variables?: Record<string, unknown>,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        ...(role ? { "x-hasura-role": role } : {}),
        ...(role === "user" ? { "x-hasura-user-id": "76561199965000001" } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data?: any; errors?: any[] };
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MapCalloutsHasura");
    await db.postgres.query(
      `INSERT INTO map_callouts (map_name, name, boxes, source) VALUES
         ('de_anubis', 'Mid', '[{"min":[0,0,0],"max":[10,10,10]}]', 'cdn'),
         ('de_anubis', 'A Site', '[{"min":[20,20,0],"max":[30,30,10]}]', 'cdn'),
         ('de_mirage', 'Window', '[{"min":[0,0,0],"max":[5,5,5]}]', 'cdn')`,
    );

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
    expect(await response.json()).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it.each(["guest", "user"])(
    "lets a %s read a map's callouts in name order with the viewer's query",
    async (role) => {
      const result = await gql(calloutsQuery, role, { mapName: "de_anubis" });
      expect(result.errors).toBeUndefined();
      expect(result.data.map_callouts.map((c: any) => c.name)).toEqual([
        "A Site",
        "Mid",
      ]);
      expect(result.data.map_callouts[0].boxes).toEqual([
        { min: [20, 20, 0], max: [30, 30, 10] },
      ]);
    },
  );

  it.each(["guest", "user"])(
    "gives a %s no way to write callouts",
    async (role) => {
      const result = await gql(
        `mutation { insert_map_callouts_one(object: {map_name: "de_anubis", name: "X", boxes: []}) { name } }`,
        role,
      );
      expect(result.errors?.[0]?.message).toMatch(/not found in type/);
    },
  );

  it.each(["guest", "user"])(
    "shows a %s the demo's parser and playback versions",
    async (role) => {
      const result = await gql(
        `{ match_map_demos(limit: 1) { id parser_version playback_version playback_url } }`,
        role,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data.match_map_demos).toEqual([]);
    },
  );
});
