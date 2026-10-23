import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { HasuraService } from "../src/hasura/hasura.service";
import { MatchesController } from "../src/matches/matches.controller";
import { RemoveCancelledMatches } from "../src/matches/jobs/RemoveCancelledMatches";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS: matches are never deleted directly through Hasura. A direct
// delete_matches takes the match's demo and clip rows with it and leaves their
// files in storage, so no role has the permission; deleting goes through the
// deleteMatch action (administrator only), which removes the files first, and
// the API's own jobs use the admin secret. Runs against the real Hasura engine
// (production version) with this repository's metadata.
describe("match delete permissions (real Hasura)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let hook: http.Server;
  let api: HasuraService;

  const adminSecret = "matches-delete-permissions-test";
  const people: Record<string, string> = {};
  const cleanup: Array<string> = [];

  const ROLES = [
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];

  async function graphql(
    query: string,
    role: string,
    steamId: string,
    variables?: Record<string, unknown>,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<{
      data?: Record<string, any>;
      errors?: Array<{ message: string }>;
    }>;
  }

  async function roleOf(steam: string) {
    const [row] = await postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [steam],
    );
    return row.role;
  }

  // The real deleteMatch, reaching Hasura the way the API does (admin secret,
  // no role) and the database directly; only storage is recorded instead.
  const controller = () => {
    const c = Object.create(MatchesController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    c.postgres = postgres;
    c.hasura = api;
    c.notifications = { send: jest.fn() };
    c.clips = {
      deleteClipsForMatch: jest.fn(async (id: string) => {
        cleanup.push(`clips:${id}`);
      }),
    };
    c.demoMetadata = {
      deleteDemosForMatch: jest.fn(async (id: string) => {
        cleanup.push(`demos:${id}`);
      }),
    };
    return c;
  };

  // A finished match outside any bracket, organized by `organizer`, with a
  // demo and a clip whose files a direct delete would orphan.
  async function playedMatch(organizer: string, status = "Finished") {
    const match = await fx.match({ type: "Duel" });
    await postgres.query(
      "UPDATE matches SET organizer_steam_id = $2, status = $3 WHERE id = $1",
      [match.id, organizer, status],
    );
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 9 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    await postgres.query(
      `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
       VALUES ($1, $2, $3, 1)`,
      [`demos/${match.id}/9.dem`, match.id, map.id],
    );
    await postgres.query(
      `INSERT INTO match_clips (match_map_id, file) VALUES ($1, $2)`,
      [map.id, `clips/system/${match.id}.mp4`],
    );
    return match.id as string;
  }

  async function rows(matchId: string) {
    const [row] = await postgres.query<
      Array<{ match: string; demos: string; clips: string }>
    >(
      `SELECT (SELECT count(*) FROM matches WHERE id = $1) AS match,
              (SELECT count(*) FROM match_map_demos WHERE match_id = $1) AS demos,
              (SELECT count(*) FROM match_clips c
                 JOIN match_maps mm ON mm.id = c.match_map_id
                WHERE mm.match_id = $1) AS clips`,
      [matchId],
    );
    return {
      match: Number(row.match),
      demos: Number(row.demos),
      clips: Number(row.clips),
    };
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MatchesDeletePermissionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199730000000n);

    // What HasuraController.actions does: the caller is the session's player.
    hook = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", async () => {
        const { action, input, session_variables } = JSON.parse(body);
        const steam = session_variables["x-hasura-user-id"];
        try {
          const result = await controller()[action.name]({
            ...input,
            user: { steam_id: steam, role: await roleOf(steam) },
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: (error as Error).message }));
        }
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as AddressInfo).port;
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
        HASURA_GRAPHQL_ACTIONS_HOOK: `http://host.docker.internal:${hookPort}`,
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

    // The API's own Hasura client, as configured in production.
    api = new HasuraService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      {} as never,
      {
        get: (key: string) =>
          key === "hasura" ? { endpoint, secret: adminSecret } : {},
      } as never,
      postgres,
    );

    await fx.region();
    for (const role of ROLES) {
      people[role] = await fx.player(role);
      await postgres.query("UPDATE players SET role = $2 WHERE steam_id = $1", [
        people[role],
        role,
      ]);
    }
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
    await new Promise((resolve) => hook?.close(resolve));
  });

  beforeEach(() => {
    cleanup.length = 0;
  });

  const DIRECT_DELETES = [
    [
      "delete_matches_by_pk",
      `mutation ($id: uuid!) { delete_matches_by_pk(id: $id) { id } }`,
    ],
    [
      "delete_matches",
      `mutation ($id: uuid!) {
         delete_matches(where: { id: { _eq: $id } }) { affected_rows }
       }`,
    ],
  ];

  describe("direct GraphQL deletion is closed for every role", () => {
    it.each(ROLES)("%s, as the match's own organizer", async (role) => {
      const matchId = await playedMatch(people[role]);

      // The organizer really is the organizer: the bypass, not the match, is
      // what is refused.
      const { data } = await graphql(
        `
          query ($id: uuid!) {
            matches_by_pk(id: $id) {
              is_organizer
            }
          }
        `,
        role,
        people[role],
        { id: matchId },
      );
      expect(data!.matches_by_pk.is_organizer).toBe(true);

      for (const [field, mutation] of DIRECT_DELETES) {
        const { errors } = await graphql(mutation, role, people[role], {
          id: matchId,
        });
        expect(errors?.[0]?.message).toContain(
          `field '${field}' not found in type: 'mutation_root'`,
        );
      }

      expect(await rows(matchId)).toEqual({ match: 1, demos: 1, clips: 1 });
    });
  });

  describe("authorized deletion still works", () => {
    it("an administrator deletes through deleteMatch, files first", async () => {
      const matchId = await playedMatch(people.user);

      const { data, errors } = await graphql(
        `
          mutation ($id: String!) {
            deleteMatch(match_id: $id) {
              success
            }
          }
        `,
        "administrator",
        people.administrator,
        { id: matchId },
      );

      expect(errors).toBeUndefined();
      expect(data!.deleteMatch.success).toBe(true);
      expect(cleanup).toEqual([`clips:${matchId}`, `demos:${matchId}`]);
      expect(await rows(matchId)).toEqual({ match: 0, demos: 0, clips: 0 });
    });

    it.each(ROLES.filter((role) => role !== "administrator"))(
      "%s cannot call deleteMatch",
      async (role) => {
        const matchId = await playedMatch(people[role]);

        const { errors } = await graphql(
          `
            mutation ($id: String!) {
              deleteMatch(match_id: $id) {
                success
              }
            }
          `,
          role,
          people[role],
          { id: matchId },
        );

        expect(errors?.[0]?.message).toContain(
          "field 'deleteMatch' not found in type: 'mutation_root'",
        );
        expect(await rows(matchId)).toEqual({ match: 1, demos: 1, clips: 1 });
      },
    );

    // RemoveCancelledMatches and deleteMatch use the API's admin-secret
    // client, which role permissions do not apply to.
    it("the API's own client still deletes (admin secret)", async () => {
      const matchId = (await fx.match({ type: "Duel" })).id as string;

      await api.mutation({
        delete_matches_by_pk: { __args: { id: matchId }, __typename: true },
      });

      expect((await rows(matchId)).match).toBe(0);
    });

    it("RemoveCancelledMatches removes an expired canceled match, files first", async () => {
      const matchId = await playedMatch(people.user, "Canceled");
      await postgres.query(
        `UPDATE matches SET cancels_at = now() - interval '2 days'
          WHERE id = $1`,
        [matchId],
      );
      const job = new RemoveCancelledMatches(
        { log: jest.fn(), warn: jest.fn() } as never,
        api,
        {
          deleteDemosForMatch: async (id: string) => {
            cleanup.push(`demos:${id}`);
          },
        } as never,
        {
          deleteClipsForMatch: async (id: string) => {
            cleanup.push(`clips:${id}`);
          },
        } as never,
      );

      await expect(job.process()).resolves.toBeGreaterThanOrEqual(1);

      expect(cleanup).toContain(`clips:${matchId}`);
      expect(cleanup).toContain(`demos:${matchId}`);
      expect((await rows(matchId)).match).toBe(0);
    });
  });

  // Other match permissions are untouched.
  it("organizers still read and update their own matches", async () => {
    const matchId = await playedMatch(people.user);

    const { data, errors } = await graphql(
      `
        query ($id: uuid!) {
          matches_by_pk(id: $id) {
            id
            is_organizer
          }
        }
      `,
      "user",
      people.user,
      { id: matchId },
    );
    expect(errors).toBeUndefined();
    expect(data!.matches_by_pk).toEqual({ id: matchId, is_organizer: true });

    const { data: schema } = await graphql(
      `
        {
          __type(name: "mutation_root") {
            fields {
              name
            }
          }
        }
      `,
      "user",
      people.user,
    );
    const mutations = schema!.__type.fields.map(
      (field: { name: string }) => field.name,
    );
    expect(mutations).toContain("update_matches_by_pk");
    expect(mutations).not.toContain("delete_matches_by_pk");
  });
});
