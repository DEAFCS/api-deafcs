import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Guests must be able to read tournament individual-signup data (the
// tournaments_by_pk page selects it unconditionally, so a missing guest
// select permission previously made the whole query -- and thus the whole
// public tournament page -- fail for logged-out visitors), but must not be
// able to write it.
describe("Guest visibility of tournament individual signups", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TournamentGuestVisibilityTest");
    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: "guest-visibility-test",
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
        "x-hasura-admin-secret": "guest-visibility-test",
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

  it("lets a guest select individual_signups on a tournament", async () => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "guest-visibility-test",
        "x-hasura-role": "guest",
      },
      body: JSON.stringify({
        query: `query GuestTournamentSignups {
          tournaments(limit: 1) {
            id
            individual_signups {
              id
              player_steam_id
              status
              checked_in_at
              player { name }
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

  it("still denies a guest inserting an individual signup", async () => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "guest-visibility-test",
        "x-hasura-role": "guest",
      },
      body: JSON.stringify({
        query: `mutation GuestCannotSignup {
          insert_tournament_individual_signups_one(
            object: {
              tournament_id: "00000000-0000-0000-0000-000000000000"
              player_steam_id: "76561199960000000"
            }
          ) {
            id
          }
        }`,
      }),
    });
    const result = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message: string }>;
    };
    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toMatch(/not found|permission|field/i);
  });
});
