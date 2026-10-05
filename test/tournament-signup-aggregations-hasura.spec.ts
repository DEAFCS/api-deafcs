import fs from "fs";
import path from "path";
import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  print,
  validate,
} from "graphql";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import {
  bootContainerAndMigrate,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Optional exact WEB documents extracted from the reviewed WEB source. The
// committed regression remains runnable without a sibling WEB checkout.
type WebDocument = {
  source: string;
  line: number;
  operation: string;
  document: string;
  roots: string[];
};
const webDocuments: WebDocument[] = process.env.TOURNAMENT_WEB_DOCUMENTS_PATH
  ? JSON.parse(
      fs.readFileSync(process.env.TOURNAMENT_WEB_DOCUMENTS_PATH, "utf8"),
    )
  : [];
const roles = [
  "guest",
  "user",
  "verified_user",
  "streamer",
  "moderator",
  "match_organizer",
  "tournament_organizer",
  "administrator",
];

describe("tournament signup aggregation permissions (real Hasura)", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let randomId: string;
  let unifiedId: string;
  let viewer: string;
  let organizer: string;
  const secret = "signup-aggregation-local-test";

  async function graphql(
    query: string,
    role: string,
    variables = {},
    steamId = viewer,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": secret,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<{
      data?: any;
      errors?: { message: string }[];
    }>;
  }
  async function metadata(type: string, args = {}) {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": secret,
      },
      body: JSON.stringify({ type, args }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(JSON.stringify(result));
    return result;
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TournamentSignupAggregation");
    const fx = new Fixtures(db.postgres, 76561199974000000n);
    const cups = new TournamentFixtures(db.postgres, fx);
    await seedRegionWithServer(db.postgres, "TestA");
    const random = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Competitive",
      1,
      true,
    );
    randomId = random.id;
    await cups.setStatus(randomId, random.organizer, "RegistrationOpen");
    for (const status of ["Registered", "Waitlisted", "Assigned"]) {
      const player = await fx.player();
      await db.postgres.query(
        "INSERT INTO tournament_individual_signups(tournament_id,player_steam_id,status) VALUES($1,$2,$3)",
        [randomId, player, status],
      );
    }
    const unified = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Wingman",
      2,
    );
    unifiedId = unified.id;
    organizer = unified.organizer;
    await db.postgres.query(
      "UPDATE tournaments SET registration_type='free_agents' WHERE id=$1",
      [unifiedId],
    );
    await cups.setStatus(unifiedId, organizer, "RegistrationOpen");
    const agent = await fx.player();
    await db.postgres.query(
      "INSERT INTO tournament_free_agents(tournament_id,player_steam_id) VALUES($1,$2)",
      [unifiedId, agent],
    );
    viewer = await fx.player();
    const other = await fx.player();
    await runAsUser(db.postgres, organizer, "admin", (query) =>
      query(
        "INSERT INTO tournament_invites(tournament_id,steam_id,invited_by_player_steam_id) VALUES($1,$2,$4),($1,$3,$4)",
        [unifiedId, viewer, other, organizer],
      ),
    );
    const url = `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;
    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: url,
        HASURA_GRAPHQL_ADMIN_SECRET: secret,
        HASURA_GRAPHQL_UNAUTHORIZED_ROLE: "guest",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://127.0.0.1:1/actions",
        HASURA_GRAPHQL_EVENT_HOOK: "http://127.0.0.1:1/events",
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
  }, 600000);
  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  const countQuery = `query($id:uuid!){ tournaments_by_pk(id:$id){ registration_version individual_signups_aggregate(where:{status:{_in:[Registered,Waitlisted]}}){aggregate{count}} individual_signups(where:{status:{_in:[Registered,Waitlisted]}}){id} } }`;

  it("reproduces the missing field before the fix and preserves player-field visibility", async () => {
    const current = await metadata("export_metadata");
    const previous = JSON.parse(JSON.stringify(current));
    const table = previous.sources
      .find((s: any) => s.name === "default")
      .tables.find(
        (t: any) => t.table.name === "tournament_individual_signups",
      );
    for (const permission of table.select_permissions)
      delete permission.permission.allow_aggregations;
    try {
      await metadata("replace_metadata", {
        allow_inconsistent_metadata: false,
        metadata: previous,
      });
      const fields: Record<string, unknown> = {};
      for (const role of ["guest", "user"]) {
        const before = await graphql(countQuery, role, { id: randomId });
        expect(before.errors?.[0]?.message).toContain(
          "individual_signups_aggregate",
        );
        fields[role] = (
          await graphql('{__type(name:"players"){fields{name}}}', role)
        ).data;
      }
      await metadata("replace_metadata", {
        allow_inconsistent_metadata: false,
        metadata: current,
      });
      for (const role of ["guest", "user"]) {
        expect(
          (await graphql('{__type(name:"players"){fields{name}}}', role)).data,
        ).toEqual(fields[role]);
      }
    } finally {
      await metadata("replace_metadata", {
        allow_inconsistent_metadata: false,
        metadata: current,
      });
    }
  }, 60000);

  it.each(roles)(
    "%s counts only rows allowed by the same select filter, including historical Random",
    async (role) => {
      const result = await graphql(countQuery, role, { id: randomId });
      expect(result.errors).toBeUndefined();
      expect(result.data.tournaments_by_pk.registration_version).toBe(1);
      expect(
        result.data.tournaments_by_pk.individual_signups_aggregate.aggregate
          .count,
      ).toBe(2);
      expect(result.data.tournaments_by_pk.individual_signups).toHaveLength(2);
    },
  );

  it("keeps private invite/code/unlock fields unavailable to guests", async () => {
    for (const table of [
      "tournament_invites",
      "tournament_invite_codes",
      "tournament_invite_code_uses",
      "tournament_registration_unlocks",
    ]) {
      expect(
        (await graphql(`{${table}{__typename}}`, "guest")).errors?.[0]?.message,
      ).toContain(table);
    }
  });
  it("normal users see only addressed invitations", async () => {
    const result = await graphql("{tournament_invites{steam_id}}", "user");
    expect(result.errors).toBeUndefined();
    expect(
      result.data.tournament_invites.map((r: any) => String(r.steam_id)),
    ).toEqual([viewer]);
  });
  it("loads consistent metadata", async () => {
    expect(await metadata("get_inconsistent_metadata")).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  // Introspection is fetched with the actual role/session headers. Validate
  // original subscriptions against that schema, then execute the identical
  // selection/arguments as an HTTP query snapshot. Never execute action
  // mutations here; the registration SQL suite covers their implementation.
  if (webDocuments.length)
    it.each(["guest", "user", "tournament_organizer", "administrator"])(
      "exact committed WEB documents validate/execute as %s",
      async (role) => {
        const steamId =
          role === "tournament_organizer" || role === "administrator"
            ? organizer
            : viewer;
        const introspection = await graphql(
          getIntrospectionQuery(),
          role,
          {},
          steamId,
        );
        expect(introspection.errors).toBeUndefined();
        const schema = buildClientSchema(introspection.data);
        for (const document of webDocuments) {
          const publicRead = document.roots.every((x) =>
            [
              "tournaments",
              "tournaments_aggregate",
              "tournaments_by_pk",
              "tournament_free_agents",
            ].includes(x),
          );
          if (role === "guest" && !publicRead) continue;
          const parsed = parse(document.document);
          const errors = validate(schema, parsed);
          expect(
            errors.map(
              (e) => `${document.source}:${document.line} ${e.message}`,
            ),
          ).toEqual([]);
          if (document.operation === "mutation") continue;
          for (const id of [randomId, unifiedId]) {
            const snapshot = {
              ...parsed,
              definitions: parsed.definitions.map((d) =>
                d.kind === "OperationDefinition"
                  ? { ...d, operation: "query" as const }
                  : d,
              ),
            };
            const candidates: Record<string, unknown> = {
              where: {},
              limit: 10,
              offset: 0,
              order_by: [{ start: "asc" }],
              tournamentId: id,
              steam_id: steamId,
              steamId,
              inviteCodeId: "00000000-0000-0000-0000-000000000001",
              id,
            };
            const names = parsed.definitions.flatMap((d) =>
              d.kind === "OperationDefinition"
                ? (d.variableDefinitions ?? []).map(
                    (v) => v.variable.name.value,
                  )
                : [],
            );
            const variables = Object.fromEntries(
              names.map((name) => [name, candidates[name]]),
            );
            const result = await graphql(
              print(snapshot),
              role,
              variables,
              steamId,
            );
            expect(
              result.errors?.map(
                (e) => document.source + ":" + document.line + " " + e.message,
              ),
            ).toBeUndefined();
          }
          console.log(
            `WEB_ROLE_PASS ${role} ${document.source}:${document.line} ${document.operation}`,
          );
        }
      },
    );
});
