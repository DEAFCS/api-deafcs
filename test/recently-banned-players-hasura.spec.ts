import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS: the /bans list is for Moderator and above. 5Stack grants
// recently_banned_players to guest; here the function and its return type are
// granted to moderator only, which match_organizer, tournament_organizer and
// administrator inherit. Run on the production engine with this repo's
// metadata, the query the /bans page sends.
describe("recently_banned_players is Moderator and above (Hasura)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const adminSecret = "recently-banned-players-test";

  const bansQuery = `query {
    recently_banned_players(args: { _window_days: 30 }) {
      steam_id
      banned_at_source
      sanction_kind
      player { steam_id name }
      sanction { id reason }
    }
    recently_banned_players_aggregate(args: { _window_days: 30 }) {
      aggregate { count }
    }
  }`;

  async function graphql(role: string, steamId?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hasura-admin-secret": adminSecret,
      "x-hasura-role": role,
    };
    if (steamId) {
      headers["x-hasura-user-id"] = steamId;
    }
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: bansQuery }),
    });
    return response.json() as Promise<{
      data?: Record<string, any>;
      errors?: Array<{ message: string }>;
    }>;
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("RecentlyBannedPlayersHasuraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199968000000n);

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
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

  it("loads consistent metadata", async () => {
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
  });

  it("lists a staff ban for moderators and every role above", async () => {
    const moderator = await fx.player("Moderator");
    const banned = await fx.player("Banned");
    // DEAFCS: the list shows registered (signed-in) players only.
    await postgres.query(
      "UPDATE players SET last_sign_in_at = now() WHERE steam_id = $1",
      [banned],
    );
    await postgres.query(
      `INSERT INTO player_sanctions
         (player_steam_id, sanctioned_by_steam_id, type, reason)
       VALUES ($1, $2, 'ban', 'cheating')`,
      [banned, moderator],
    );

    for (const role of [
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ]) {
      const result = await graphql(role, moderator);
      expect(result.errors).toBeUndefined();
      expect(result.data?.recently_banned_players).toEqual([
        {
          steam_id: banned,
          banned_at_source: "5stack",
          sanction_kind: "staff",
          player: { steam_id: banned, name: "Banned" },
          sanction: { id: expect.any(String), reason: "cheating" },
        },
      ]);
      expect(
        result.data?.recently_banned_players_aggregate.aggregate.count,
      ).toBe(1);
    }
  });

  it("is not in the schema for guests, users, verified users or streamers", async () => {
    const viewer = await fx.player("Viewer");
    for (const role of ["guest", "user", "verified_user", "streamer"]) {
      const result = await graphql(role, role === "guest" ? undefined : viewer);
      expect(result.data).toBeUndefined();
      expect(result.errors?.[0]?.message).toMatch(
        /field 'recently_banned_players' not found/,
      );
    }
  });
});
