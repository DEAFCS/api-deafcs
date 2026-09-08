import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Proves two things a static YAML read can't, against a real Hasura instance
// bound to the repo's hasura/metadata -- same harness as
// terms-acceptance-permissions.spec.ts:
//
// 1. The new `administrator` select permission on player_terms_acceptances
//    (added for the read-only admin Terms Acceptances page) grants exactly
//    what it should -- every player's row, the three evidence columns -- and
//    does NOT widen `user`'s existing own-row-only access. `user` still
//    cannot read another player's row, and still cannot enumerate the table.
//
// 2. players' has_accepted_current_terms computed field (no session_argument,
//    scalar boolean) is actually filterable via `where`, which the admin
//    page's players query relies on. This was an open question -- Hasura
//    only exposes a computed field in <table>_bool_exp when it's a scalar
//    computed field without a session argument, and nothing else in this
//    codebase filters on it, so it had never been exercised end-to-end.
describe("Terms Acceptances admin page (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "terms-acceptances-admin-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TermsAcceptancesAdminTest");
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
        HASURA_GRAPHQL_ADMIN_SECRET: ADMIN_SECRET,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        // Matches production (confirmed live on the `hasura` Deployment):
        // without this, Hasura serializes bigint columns (steam ids) as bare
        // JSON numbers, which JSON.parse silently rounds past 2^53 -- steam
        // ids are ~7.6e16, so every id in a test run collides on the same
        // rounded double. With it, steam ids round-trip as exact strings,
        // same as every real client (web app included) actually receives.
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

  const gql = async (
    query: string,
    role: string,
    steamId?: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
      "x-hasura-role": role,
    };
    if (steamId) headers["x-hasura-user-id"] = steamId;
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    return response.json();
  };

  it("has zero inconsistent metadata objects", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    const result = (await response.json()) as {
      is_consistent: boolean;
      inconsistent_objects: unknown[];
    };
    expect(result).toEqual({ is_consistent: true, inconsistent_objects: [] });
  });

  describe("role=user (own-row-only, unchanged by the admin permission)", () => {
    it("can read their own player_terms_acceptances row", async () => {
      const player = await fx.player();
      const result = await gql(
        `query {
          player_terms_acceptances(where: { player_steam_id: { _eq: "${player}" } }) {
            player_steam_id
            terms_version
          }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.player_terms_acceptances).toEqual([
        expect.objectContaining({ player_steam_id: player }),
      ]);
    });

    it("cannot read another player's acceptance row, even when explicitly requested", async () => {
      const viewer = await fx.player();
      const other = await fx.player();
      const result = await gql(
        `query {
          player_terms_acceptances(where: { player_steam_id: { _eq: "${other}" } }) {
            player_steam_id
          }
        }`,
        "user",
        viewer,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.player_terms_acceptances).toEqual([]);
    });

    it("cannot enumerate all players' acceptance records with an unfiltered query", async () => {
      const viewer = await fx.player();
      // Two other accepted players besides the viewer -- if the admin
      // permission had accidentally widened `user`'s filter instead of
      // being added as its own role, this would leak all three.
      await fx.player();
      await fx.player();

      const result = await gql(
        `query { player_terms_acceptances { player_steam_id } }`,
        "user",
        viewer,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.player_terms_acceptances).toEqual([
        { player_steam_id: viewer },
      ]);
    });
  });

  describe("role=administrator (the new permission)", () => {
    it("can read acceptance rows belonging to multiple different players, with the expected columns", async () => {
      const admin = await fx.player();
      const playerA = await fx.player();
      const playerB = await fx.player();

      const result = await gql(
        `query {
          player_terms_acceptances(
            where: { player_steam_id: { _in: ["${playerA}", "${playerB}"] } }
            order_by: { player_steam_id: asc }
          ) {
            player_steam_id
            terms_version
            accepted_at
          }
        }`,
        "administrator",
        admin,
      );

      expect(result.errors).toBeUndefined();
      const rows = result.data?.player_terms_acceptances ?? [];
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r: any) => r.player_steam_id))).toEqual(
        new Set([playerA, playerB]),
      );
      for (const row of rows) {
        expect(row).toEqual(
          expect.objectContaining({
            player_steam_id: expect.any(String),
            terms_version: expect.any(String),
            accepted_at: expect.any(String),
          }),
        );
      }
    });

    it("does not gain write access from the new select permission (read-only, as intended)", async () => {
      const admin = await fx.player();
      const player = await fx.player();
      const result = await gql(
        `mutation {
          delete_player_terms_acceptances(where: { player_steam_id: { _eq: "${player}" } }) {
            affected_rows
          }
        }`,
        "administrator",
        admin,
      );
      expect(result.errors).toBeDefined();
    });
  });

  describe("players.has_accepted_current_terms computed-field filtering", () => {
    it("where: { has_accepted_current_terms: { _eq: true } } returns exactly the accepted player", async () => {
      const accepted = await fx.player();
      const unaccepted = await fx.player(undefined, { acceptTerms: false });

      const result = await gql(
        `query {
          players(
            where: {
              steam_id: { _in: ["${accepted}", "${unaccepted}"] }
              has_accepted_current_terms: { _eq: true }
            }
          ) { steam_id }
        }`,
        "user",
        accepted,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.players).toEqual([{ steam_id: accepted }]);
    });

    it("where: { has_accepted_current_terms: { _eq: false } } returns exactly the unaccepted player", async () => {
      const accepted = await fx.player();
      const unaccepted = await fx.player(undefined, { acceptTerms: false });

      const result = await gql(
        `query {
          players(
            where: {
              steam_id: { _in: ["${accepted}", "${unaccepted}"] }
              has_accepted_current_terms: { _eq: false }
            }
          ) { steam_id }
        }`,
        "user",
        accepted,
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.players).toEqual([{ steam_id: unaccepted }]);
    });
  });
});
