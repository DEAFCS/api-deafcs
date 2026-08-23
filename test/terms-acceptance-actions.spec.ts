import http from "http";
import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TermsService } from "./../src/terms/terms.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// `permissions: [{ role: user }]` on a Hasura Action does NOT necessarily
// mean every higher/inherited role can call it -- that depends on how
// Hasura resolves action-execute permissions for inherited roles, which is
// a real question, not something to assume from the YAML alone. This spins
// up a real Hasura engine bound to the actual hasura/metadata (so the real
// acceptTerms registration + inherited_roles.yaml are what's being tested)
// and proves, for every authenticated role DEAFCS actually has, that a
// GraphQL call to acceptTerms is accepted by Hasura's permission layer and
// reaches the real TermsService, which records a real acceptance row --
// not just that the request "looks" successful.
//
// The action webhook itself is a minimal HTTP handler wrapping the real
// TermsService against the same test database, rather than the full Nest
// app (which would need a real Passport session store) -- this is enough
// to prove both the permission boundary and the actual business behavior,
// without dragging in unrelated session/auth plumbing this test isn't
// about.
describe("acceptTerms Action permissions across every authenticated role (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let webhookServer: http.Server;
  let webhookPort: number;

  const ADMIN_SECRET = "terms-acceptance-actions-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TermsAcceptanceActionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199965000000n);
    const terms = new TermsService(postgres);

    webhookServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const steamId = payload?.session_variables?.["x-hasura-user-id"];
          const result = await terms.acceptCurrentTerms(steamId);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (error: any) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: error?.message ?? String(error) }));
        }
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
    webhookPort = (webhookServer.address() as { port: number }).port;

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: ADMIN_SECRET,
        // No path appended: every action handler in actions.yaml is the
        // literal '{{HASURA_GRAPHQL_ACTIONS_HOOK}}' string with nothing
        // appended, so this is the exact URL Hasura POSTs the action to.
        HASURA_GRAPHQL_ACTIONS_HOOK: `http://host.docker.internal:${webhookPort}`,
        HASURA_GRAPHQL_EVENT_HOOK: `http://host.docker.internal:${webhookPort}/events`,
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
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await db?.stop();
  });

  const acceptTerms = async (
    role: string,
    steamId: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({
        query: `mutation { acceptTerms { success } }`,
      }),
    });
    return response.json();
  };

  const hasAcceptanceRow = async (steamId: string): Promise<boolean> => {
    const rows = await postgres.query<Array<{ terms_version: string }>>(
      "SELECT terms_version FROM player_terms_acceptances WHERE player_steam_id = $1",
      [steamId],
    );
    return rows.length > 0;
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

  // Every role a real authenticated DEAFCS player can hold, per
  // hasura/metadata/inherited_roles.yaml's chain: guest < user <
  // verified_user < streamer < moderator < match_organizer <
  // tournament_organizer < administrator.
  describe.each([
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ])("role: %s", (role) => {
    it("can call acceptTerms while unaccepted, and it records a real acceptance row", async () => {
      const steamId = await fx.player(undefined, { acceptTerms: false });
      await postgres.query("UPDATE players SET role = $1 WHERE steam_id = $2", [
        role,
        steamId,
      ]);

      expect(await hasAcceptanceRow(steamId)).toBe(false);

      const result = await acceptTerms(role, steamId);

      expect(result.errors).toBeUndefined();
      expect(result.data?.acceptTerms?.success).toBe(true);
      expect(await hasAcceptanceRow(steamId)).toBe(true);
    });
  });

  it("guest (unauthenticated) cannot call acceptTerms -- the action requires a real session, not just any request", async () => {
    const result = await acceptTerms("guest", "0");
    expect(result.errors).toBeDefined();
    expect(result.data?.acceptTerms ?? null).toBeNull();
  });
});
