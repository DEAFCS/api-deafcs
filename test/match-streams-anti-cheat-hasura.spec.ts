import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Anti-cheat for manual/caster streams (and the game streamer row): the
// match_streams select permission (guest, inherited by every role) hides a
// match's streams from its own players and coaches, server-side, so the
// links can't be read through GraphQL either. Spectators, guests and staff
// who don't play keep seeing and managing them.
describe("match_streams anti-cheat (Hasura permissions)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const adminSecret = "match-streams-anti-cheat-test";
  let matchId: string;
  let player: string;
  let coach: string;
  let spectator: string;
  let admin: string;
  let playingAdmin: string;
  let organizer: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MatchStreamsAntiCheatHasuraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199965000000n);

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    // Same engine version as production.
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

    // A match needs a region with a server (match veto prerequisite).
    await fx.region();
    const bare = await fx.bareMatch();
    matchId = bare.matchId;
    const [lineups] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    player = await fx.lineupPlayer(lineups.lineup_1_id);
    playingAdmin = await fx.lineupPlayer(lineups.lineup_2_id);
    coach = await fx.player("Coach");
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
      [lineups.lineup_2_id, coach],
    );
    spectator = await fx.player("Spectator");
    admin = await fx.player("Admin");
    organizer = await fx.player("Organizer");

    await postgres.query(
      `INSERT INTO match_streams (match_id, link, title, priority, is_game_streamer)
       VALUES ($1, 'https://www.twitch.tv/official_cast', 'Official cast', 1, false),
              ($1, 'https://www.twitch.tv/second_cast', 'Second cast', 2, false)`,
      [matchId],
    );
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
      data?: Record<string, any>;
      errors?: Array<{ message: string }>;
    }>;
  }

  // Both ways the web reads streams: the table and the match relationship.
  async function visibleLinks(role: string, steamId: string) {
    const { data, errors } = await graphql(
      `{
        match_streams(where: { match_id: { _eq: "${matchId}" } }, order_by: { priority: asc }) { link }
        matches_by_pk(id: "${matchId}") { streams(order_by: { priority: asc }) { link } }
      }`,
      role,
      steamId,
    );
    expect(errors).toBeUndefined();
    const direct = data!.match_streams.map((s: { link: string }) => s.link);
    const nested = (data!.matches_by_pk?.streams ?? []).map((s: { link: string }) => s.link);
    expect(nested).toEqual(direct);
    return direct;
  }

  const ALL = ["https://www.twitch.tv/official_cast", "https://www.twitch.tv/second_cast"];

  it("loads consistent metadata", async () => {
    const metadata = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": adminSecret },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    await expect(metadata.json()).resolves.toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("a player of the match cannot retrieve its streams", async () => {
    expect(await visibleLinks("user", player)).toEqual([]);
    expect(await visibleLinks("verified_user", player)).toEqual([]);
  });

  it("a coach of the match cannot retrieve its streams", async () => {
    expect(await visibleLinks("user", coach)).toEqual([]);
  });

  it("staff who play in the match get nothing either", async () => {
    expect(await visibleLinks("administrator", playingAdmin)).toEqual([]);
  });

  it("guests and spectators can retrieve them", async () => {
    expect(await visibleLinks("guest", "0")).toEqual(ALL);
    expect(await visibleLinks("user", spectator)).toEqual(ALL);
  });

  it("an admin and a match organizer who don't play can retrieve them", async () => {
    expect(await visibleLinks("administrator", admin)).toEqual(ALL);
    expect(await visibleLinks("match_organizer", organizer)).toEqual(ALL);
  });

  it("manual stream management still works for staff who don't play", async () => {
    const inserted = await graphql(
      `mutation {
        insert_match_streams_one(object: {
          match_id: "${matchId}", link: "https://www.twitch.tv/third_cast", title: "Third cast", priority: 3
        }) { id title }
      }`,
      "match_organizer",
      organizer,
    );
    expect(inserted.errors).toBeUndefined();
    const id = inserted.data!.insert_match_streams_one.id;
    expect(inserted.data!.insert_match_streams_one.title).toBe("Third cast");

    const updated = await graphql(
      `mutation { update_match_streams_by_pk(pk_columns: { id: "${id}" }, _set: { title: "Renamed cast" }) { title } }`,
      "match_organizer",
      organizer,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.update_match_streams_by_pk.title).toBe("Renamed cast");
    expect(await visibleLinks("administrator", admin)).toEqual([
      ...ALL,
      "https://www.twitch.tv/third_cast",
    ]);

    // The new row is just as hidden from the match's own player.
    expect(await visibleLinks("user", player)).toEqual([]);
  });
});
