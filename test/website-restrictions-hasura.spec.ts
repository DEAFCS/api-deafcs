import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

describe("website restriction Hasura enforcement", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const adminSecret = "website-restrictions-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("WebsiteRestrictionsHasuraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199964000000n);

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
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
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  async function graphql(query: string, role: string, steamId: string) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({ query }),
    });
    return response.json() as Promise<{
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    }>;
  }

  it("loads consistent metadata and rejects direct social and support mutations", async () => {
    const metadata = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    await expect(metadata.json()).resolves.toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });

    const administrator = await fx.player("Administrator");
    const restricted = await fx.player("Restricted");
    const other = await fx.player("Other");
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'website_restriction', 'abuse')`,
      [restricted, administrator],
    );

    const friendResult = await graphql(
      `mutation {
        insert_my_friends_one(object: { steam_id: "${other}" }) { steam_id }
      }`,
      "user",
      restricted,
    );
    // Hasura intentionally masks PostgreSQL exception text for non-admin
    // callers, so assert the database rejection and the absence of a row.
    expect(friendResult.errors?.[0]?.message).toBe("database query error");

    const supportResult = await graphql(
      `mutation {
        insert_support_requests_one(object: {
          category: general_support,
          subject: "Internal appeal",
          initial_message: "This must be rejected by the database guard."
        }) { id }
      }`,
      "verified_user",
      restricted,
    );
    expect(supportResult.errors?.[0]?.message).toBe("database query error");

    const [counts] = await postgres.query<
      Array<{ friends: string; support_requests: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM friends) AS friends,
         (SELECT count(*)::text FROM support_requests) AS support_requests`,
    );
    expect(counts).toEqual({ friends: "0", support_requests: "0" });
  });
});
