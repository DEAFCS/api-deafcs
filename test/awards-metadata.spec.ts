import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

describe("Awards Phase A compatibility metadata", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("AwardsMetadataTest");
    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: "metadata-test",
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
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
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  it("has zero inconsistent metadata objects", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "metadata-test",
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    const result = (await response.json()) as {
      is_consistent: boolean;
      inconsistent_objects: unknown[];
    };
    expect(result).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("exposes compatibility relationships in GraphQL", async () => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "metadata-test",
        "x-hasura-role": "guest",
      },
      body: JSON.stringify({
        query: `query AwardsCompatibility {
          tournaments(limit: 1) {
            trophies {
              id
              tournament { id }
              tournament_team { id }
              player { steam_id }
              team { id }
            }
            trophy_configs {
              id
              tournament { id }
            }
          }
          players(limit: 1) {
            tournament_trophies {
              id
              tournament { id }
            }
          }
        }`,
      }),
    });
    const result = (await response.json()) as {
      data?: unknown;
      errors?: unknown[];
    };
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
  });
});
