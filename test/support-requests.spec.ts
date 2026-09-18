import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

describe("Support requests (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "support-requests-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("SupportRequestsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199978000000n);

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
    variables?: Record<string, unknown>,
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
      body: JSON.stringify({ query, variables }),
    });
    return response.json();
  };

  const INSERT_REQUEST = `
    mutation Insert($object: support_requests_insert_input!) {
      insert_support_requests_one(object: $object) {
        id player_steam_id category subject status
        reported_player_steam_id report_reason report_details
        organizer_motivation organizer_experience organizer_languages
      }
    }
  `;

  // Creating a support request requires role verified_user and above (see
  // public_support_requests.yaml's insert_permissions) -- these test
  // players don't need players.role actually set to verified_user in
  // Postgres for that, since this harness's gql() sets x-hasura-role
  // directly on the request, the same way the real auth webhook's
  // resolved role would arrive. Everything else (selecting your own
  // request, replying on it) is unrelated to that permission and stays on
  // role "user" below, matching public_support_requests.yaml's unchanged
  // select_permissions and public_support_request_messages.yaml.
  const insertGeneral = async (player: string) =>
    gql(INSERT_REQUEST, "verified_user", player, {
      object: {
        category: "general_support",
        subject: "Need help",
        initial_message: "I need help with a DEAFCS feature.",
      },
    });

  it("loads with consistent metadata", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    expect(await response.json()).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("rejects support request creation for an unverified (role user) player", async () => {
    const player = await fx.player();
    const result = await gql(INSERT_REQUEST, "user", player, {
      object: {
        category: "general_support",
        subject: "Need help",
        initial_message: "I need help with a DEAFCS feature.",
      },
    });
    // Hasura excludes a mutation field entirely from a role's schema when
    // that role has no insert permission for it -- a validation-failed
    // "field not found" error, not a runtime authorization error, but
    // either way nothing gets inserted.
    expect(result.errors).toBeDefined();
    expect(result.data?.insert_support_requests_one ?? null).toBeNull();
  });

  it("rejects support request creation for a guest (no authenticated role)", async () => {
    const result = await gql(INSERT_REQUEST, "guest", undefined, {
      object: {
        category: "general_support",
        subject: "Need help",
        initial_message: "I need help with a DEAFCS feature.",
      },
    });
    expect(result.errors).toBeDefined();
    expect(result.data?.insert_support_requests_one ?? null).toBeNull();
  });

  it("allows support request creation for verified_user and every role above it", async () => {
    for (const role of [
      "verified_user",
      "moderator",
      "administrator",
    ]) {
      const player = await fx.player();
      const result = await gql(INSERT_REQUEST, role, player, {
        object: {
          category: "general_support",
          subject: `Need help (${role})`,
          initial_message: "I need help with a DEAFCS feature.",
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_support_requests_one).toMatchObject({
        player_steam_id: player,
        status: "open",
      });
    }
  });

  it("forces ownership and lets a player select only their own request", async () => {
    const owner = await fx.player();
    const other = await fx.player();
    const inserted = await insertGeneral(owner);

    expect(inserted.errors).toBeUndefined();
    expect(inserted.data?.insert_support_requests_one).toMatchObject({
      player_steam_id: owner,
      category: "general_support",
      status: "open",
    });

    const id = inserted.data.insert_support_requests_one.id;
    const own = await gql(
      `query { support_requests_by_pk(id: "${id}") { id subject } }`,
      "user",
      owner,
    );
    const crossUser = await gql(
      `query { support_requests_by_pk(id: "${id}") { id subject } }`,
      "user",
      other,
    );

    expect(own.data?.support_requests_by_pk?.id).toBe(id);
    expect(crossUser.data?.support_requests_by_pk).toBeNull();
  });

  it("rejects forged owners and statuses", async () => {
    const owner = await fx.player();
    const other = await fx.player();
    const result = await gql(INSERT_REQUEST, "verified_user", owner, {
      object: {
        player_steam_id: other,
        status: "closed",
        category: "feedback",
        subject: "A suggestion",
        initial_message: "This suggestion has enough detail to submit.",
      },
    });
    expect(result.errors).toBeDefined();
    expect(result.data?.insert_support_requests_one ?? null).toBeNull();
  });

  it("keeps structured player-report details private", async () => {
    const reporter = await fx.player();
    const other = await fx.player();
    const reported = await fx.player();
    const inserted = await gql(INSERT_REQUEST, "verified_user", reporter, {
      object: {
        category: "player_report",
        subject: "Player conduct report",
        initial_message: "Please review this private player conduct report.",
        reported_player_steam_id: reported,
        related_match_reference: "https://deafcs.net/matches/example",
        report_reason: "Harassment",
        report_details:
          "The player repeatedly harassed teammates during the match.",
        report_evidence: "Chat timestamps are available in the match record.",
      },
    });
    expect(inserted.errors).toBeUndefined();

    const id = inserted.data.insert_support_requests_one.id;
    const hidden = await gql(
      `query { support_requests_by_pk(id: "${id}") { id report_details } }`,
      "user",
      other,
    );
    const admin = await gql(
      `query { support_requests_by_pk(id: "${id}") { id reported_player_steam_id report_reason report_details } }`,
      "administrator",
      await fx.player(),
    );
    expect(hidden.data?.support_requests_by_pk).toBeNull();
    expect(admin.data?.support_requests_by_pk).toMatchObject({
      reported_player_steam_id: reported,
      report_reason: "Harassment",
    });
  });

  it("requires the structured fields for player reports", async () => {
    const reporter = await fx.player();
    const result = await gql(INSERT_REQUEST, "verified_user", reporter, {
      object: {
        category: "player_report",
        subject: "Incomplete report",
        initial_message: "This report intentionally omits the required fields.",
      },
    });
    expect(result.errors).toBeDefined();
  });

  it("stores a tournament organizer application without granting a role", async () => {
    const applicant = await fx.player();
    const result = await gql(INSERT_REQUEST, "verified_user", applicant, {
      object: {
        category: "organizer_application",
        subject: "Tournament organizer application",
        initial_message: "I would like to help run community tournaments.",
        organizer_motivation:
          "I want to create reliable events for Deaf players.",
        organizer_experience: "I have helped moderate two community cups.",
        organizer_languages: "Danish, English, Danish Sign Language",
      },
    });
    expect(result.errors).toBeUndefined();
    expect(
      result.data?.insert_support_requests_one.organizer_motivation,
    ).toMatch(/reliable events/);
    const [player] = await postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [applicant],
    );
    expect(player.role).toBe("user");
  });

  it("protects request messages and admin identity", async () => {
    const owner = await fx.player();
    const other = await fx.player();
    const admin = await fx.player();
    const inserted = await insertGeneral(owner);
    const id = inserted.data.insert_support_requests_one.id;

    const ownReply = await gql(
      `mutation { insert_support_request_messages_one(object: { request_id: "${id}", message: "Here is more detail." }) { id is_admin sender_steam_id } }`,
      "user",
      owner,
    );
    const crossReply = await gql(
      `mutation { insert_support_request_messages_one(object: { request_id: "${id}", message: "I should not be able to reply." }) { id } }`,
      "user",
      other,
    );
    const adminReply = await gql(
      `mutation { insert_support_request_messages_one(object: { request_id: "${id}", message: "An administrator reply." }) { id is_admin sender_steam_id } }`,
      "administrator",
      admin,
    );
    const crossRead = await gql(
      `query { support_request_messages(where: { request_id: { _eq: "${id}" } }) { id message } }`,
      "user",
      other,
    );

    expect(ownReply.data?.insert_support_request_messages_one).toMatchObject({
      is_admin: false,
      sender_steam_id: owner,
    });
    expect(crossReply.errors).toBeDefined();
    expect(adminReply.data?.insert_support_request_messages_one).toMatchObject({
      is_admin: true,
      sender_steam_id: admin,
    });
    expect(crossRead.data?.support_request_messages).toEqual([]);
  });

  it("lets an admin close and reopen a request and blocks replies while closed", async () => {
    const owner = await fx.player();
    const admin = await fx.player();
    const inserted = await insertGeneral(owner);
    const id = inserted.data.insert_support_requests_one.id;

    const closed = await gql(
      `mutation { update_support_requests_by_pk(pk_columns: { id: "${id}" }, _set: { status: closed }) { status closed_at handled_by_steam_id } }`,
      "administrator",
      admin,
    );
    expect(closed.errors).toBeUndefined();
    expect(closed.data?.update_support_requests_by_pk).toMatchObject({
      status: "closed",
      handled_by_steam_id: admin,
    });
    expect(closed.data?.update_support_requests_by_pk.closed_at).toBeTruthy();

    const blocked = await gql(
      `mutation { insert_support_request_messages_one(object: { request_id: "${id}", message: "Closed reply" }) { id } }`,
      "user",
      owner,
    );
    expect(blocked.errors).toBeDefined();

    const reopened = await gql(
      `mutation { update_support_requests_by_pk(pk_columns: { id: "${id}" }, _set: { status: open }) { status closed_at } }`,
      "administrator",
      admin,
    );
    expect(reopened.data?.update_support_requests_by_pk).toEqual({
      status: "open",
      closed_at: null,
    });

    const replyAfterReopen = await gql(
      `mutation { insert_support_request_messages_one(object: { request_id: "${id}", message: "Reply after reopen" }) { id is_admin sender_steam_id } }`,
      "user",
      owner,
    );
    expect(replyAfterReopen.errors).toBeUndefined();
    expect(
      replyAfterReopen.data?.insert_support_request_messages_one,
    ).toMatchObject({
      is_admin: false,
      sender_steam_id: owner,
    });
  });
});
