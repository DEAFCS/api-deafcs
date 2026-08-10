import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// team_roster.roster_image_url used to be directly writable via Hasura
// GraphQL by roles "tournament_organizer" and "user" (team Admin),
// completely bypassing AvatarsService's upload/validation pipeline. This
// spec proves that direct-mutation bypass is closed while the other
// team_roster columns those roles still legitimately manage (coach, role,
// status) remain writable.
describe("team_roster.roster_image_url Hasura direct-mutation bypass", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("RosterImageBypassTest");
    fx = new Fixtures(db.postgres, 76561199700000000n);

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

  async function graphql(
    role: string,
    userId: string | null,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hasura-admin-secret": "metadata-test",
      "x-hasura-role": role,
    };
    if (userId) headers["x-hasura-user-id"] = userId;

    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data?: any; errors?: any[] };
  }

  it("rejects a tournament_organizer directly mutating roster_image_url", async () => {
    const team = await fx.team(1);
    const [{ player_steam_id }] = (await db.postgres.query<
      Array<{ player_steam_id: string }>
    >("SELECT player_steam_id FROM team_roster WHERE team_id = $1 LIMIT 1", [
      team.id,
    ])) as Array<{ player_steam_id: string }>;

    const result = await graphql(
      "tournament_organizer",
      "76561199700000099",
      `mutation ($teamId: uuid!, $steamId: bigint!) {
        update_team_roster_by_pk(
          pk_columns: { team_id: $teamId, player_steam_id: $steamId }
          _set: { roster_image_url: "avatars/roster-teams/hacked.png" }
        ) {
          roster_image_url
        }
      }`,
      { teamId: team.id, steamId: player_steam_id },
    );

    expect(result.data).toBeFalsy();
    expect(result.errors).toBeDefined();
    expect(JSON.stringify(result.errors)).toMatch(
      /roster_image_url|field.*not found|permission/i,
    );

    const [row] = (await db.postgres.query<
      Array<{ roster_image_url: string | null }>
    >(
      "SELECT roster_image_url FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
      [team.id, player_steam_id],
    )) as Array<{ roster_image_url: string | null }>;
    expect(row.roster_image_url).toBeNull();
  });

  it("rejects a team Admin (role=user) directly mutating roster_image_url", async () => {
    const team = await fx.team(1);
    const [{ player_steam_id: adminSteam }] = (await db.postgres.query<
      Array<{ player_steam_id: string }>
    >("SELECT player_steam_id FROM team_roster WHERE team_id = $1 LIMIT 1", [
      team.id,
    ])) as Array<{ player_steam_id: string }>;
    await db.postgres.query(
      "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
      [team.id, adminSteam],
    );

    const result = await graphql(
      "user",
      adminSteam,
      `mutation ($teamId: uuid!, $steamId: bigint!) {
        update_team_roster_by_pk(
          pk_columns: { team_id: $teamId, player_steam_id: $steamId }
          _set: { roster_image_url: "avatars/roster-teams/hacked.png" }
        ) {
          roster_image_url
        }
      }`,
      { teamId: team.id, steamId: adminSteam },
    );

    expect(result.data).toBeFalsy();
    expect(result.errors).toBeDefined();
  });

  it("still allows tournament_organizer to update the unrelated 'coach' column (fix is scoped, not a blanket lockout)", async () => {
    const team = await fx.team(1);
    const [{ player_steam_id }] = (await db.postgres.query<
      Array<{ player_steam_id: string }>
    >("SELECT player_steam_id FROM team_roster WHERE team_id = $1 LIMIT 1", [
      team.id,
    ])) as Array<{ player_steam_id: string }>;

    const result = await graphql(
      "tournament_organizer",
      "76561199700000099",
      `mutation ($teamId: uuid!, $steamId: bigint!) {
        update_team_roster_by_pk(
          pk_columns: { team_id: $teamId, player_steam_id: $steamId }
          _set: { coach: true }
        ) {
          coach
        }
      }`,
      { teamId: team.id, steamId: player_steam_id },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.update_team_roster_by_pk?.coach).toBe(true);
  });
});
