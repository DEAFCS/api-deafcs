import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Exercises the new verification_application_known_players child table (the
// repeatable "up to 3 known deaf/DEAFCS CS players" reference list) against a
// real Hasura instance -- same harness as verification-applications-applicant
// -fields.spec.ts. A static metadata/migration read can't prove:
//
// 1. the nested insert (verification_applications + known_players in one
//    request) is atomic and permission-safe for role=user;
// 2. a player can only create/read references on their OWN application, not
//    someone else's, through the relational check/filter on `application`;
// 3. the max-3-per-application invariant is actually enforced by the
//    CHECK(sort_order BETWEEN 1 AND 3) + UNIQUE(application_id, sort_order)
//    pair at the database level, not just by client-side UI;
// 4. no update/delete permission was accidentally granted on the child table;
// 5. the legacy single-reference columns on the parent (deaf_player_nickname,
//    deaf_player_steam_url) still round-trip untouched for historical rows
//    that predate this table.
describe("Verification application known players (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "verification-known-players-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("VerificationKnownPlayersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199966000000n);

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

  const baseApplication = () => ({
    is_deaf: "yes",
    country: "US",
    knows_deaf_player: true,
    account_declaration_accepted_at: new Date().toISOString(),
  });

  const INSERT_WITH_KNOWN_PLAYERS = `
    mutation Insert($object: verification_applications_insert_input!) {
      insert_verification_applications_one(object: $object) {
        id
        known_players(order_by: { sort_order: asc }) {
          id
          nickname
          steam_profile_url
          sort_order
        }
      }
    }
  `;

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

  it("the child table migration created verification_application_known_players", async () => {
    const [row] = await postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'verification_application_known_players'
       ) AS "exists"`,
    );
    expect(row.exists).toBe(true);
  });

  describe("nested insert: parent + known_players in one request", () => {
    it("creates the application and up to 3 references atomically for role=user", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: {
            data: [
              { nickname: "PlayerOne", steam_profile_url: "https://steamcommunity.com/id/playerone", sort_order: 1 },
              { nickname: "PlayerTwo", steam_profile_url: null, sort_order: 2 },
            ],
          },
        },
      });

      expect(result.errors).toBeUndefined();
      const row = result.data?.insert_verification_applications_one;
      expect(row.known_players).toEqual([
        expect.objectContaining({ nickname: "PlayerOne", sort_order: 1 }),
        expect.objectContaining({ nickname: "PlayerTwo", sort_order: 2 }),
      ]);
    });

    it("allows YES with zero completed references (Player 1 left fully empty)", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [] },
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_verification_applications_one?.known_players).toEqual([]);
    });

    it("does not leave orphan known_player rows when the parent insert fails", async () => {
      // Omitting account_declaration_accepted_at trips
      // tbi_verification_applications and rejects the whole insert -- the
      // nested known_players rows must not survive that failure, since a
      // single GraphQL mutation is one DB transaction.
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          is_deaf: "yes",
          country: "US",
          knows_deaf_player: true,
          known_players: {
            data: [{ nickname: "ShouldNotPersist", sort_order: 1 }],
          },
        },
      });
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_verification_applications_one ?? null).toBeNull();

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*)::text AS count FROM verification_application_known_players WHERE nickname = 'ShouldNotPersist'",
      );
      expect(count).toBe("0");
    });
  });

  describe("row-ownership: a player can only touch references on their own application", () => {
    it("cannot insert a known_player row directly against another player's application", async () => {
      const owner = await fx.player();
      const attacker = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", owner, {
        object: { ...baseApplication(), known_players: { data: [] } },
      });
      const applicationId = inserted.data.insert_verification_applications_one.id;

      const result = await gql(
        `mutation {
          insert_verification_application_known_players_one(object: {
            verification_application_id: "${applicationId}"
            nickname: "Intruder"
            sort_order: 1
          }) { id }
        }`,
        "user",
        attacker,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_verification_application_known_players_one ?? null).toBeNull();

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*)::text AS count FROM verification_application_known_players WHERE verification_application_id = $1",
        [applicationId],
      );
      expect(count).toBe("0");
    });

    it("cannot enumerate another player's known_players via select", async () => {
      const owner = await fx.player();
      const viewer = await fx.player();
      await gql(INSERT_WITH_KNOWN_PLAYERS, "user", owner, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "Secret", sort_order: 1 }] },
        },
      });

      const result = await gql(
        `query { verification_application_known_players(where: { nickname: { _eq: "Secret" } }) { id nickname } }`,
        "user",
        viewer,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_application_known_players).toEqual([]);
    });

    it("can read the references on their own application", async () => {
      const player = await fx.player();
      await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "OwnRef", sort_order: 1 }] },
        },
      });

      const result = await gql(
        `query { verification_application_known_players(where: { nickname: { _eq: "OwnRef" } }) { id nickname } }`,
        "user",
        player,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_application_known_players).toEqual([
        expect.objectContaining({ nickname: "OwnRef" }),
      ]);
    });
  });

  describe("role=administrator", () => {
    it("can read known_players on any application", async () => {
      const admin = await fx.player();
      const applicant = await fx.player();
      await gql(INSERT_WITH_KNOWN_PLAYERS, "user", applicant, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "AdminVisible", sort_order: 1 }] },
        },
      });

      const result = await gql(
        `query { verification_application_known_players(where: { nickname: { _eq: "AdminVisible" } }) { id nickname } }`,
        "administrator",
        admin,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_application_known_players).toEqual([
        expect.objectContaining({ nickname: "AdminVisible" }),
      ]);
    });
  });

  describe("no accidental broad permissions on the child table", () => {
    it("has no update permission for role=user", async () => {
      const player = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "Original", sort_order: 1 }] },
        },
      });
      const rowId = inserted.data.insert_verification_applications_one.known_players[0].id;

      const result = await gql(
        `mutation { update_verification_application_known_players_by_pk(pk_columns: { id: "${rowId}" }, _set: { nickname: "Changed" }) { id } }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
    });

    it("has no delete permission for role=user", async () => {
      const player = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "ToKeep", sort_order: 1 }] },
        },
      });
      const rowId = inserted.data.insert_verification_applications_one.known_players[0].id;

      const result = await gql(
        `mutation { delete_verification_application_known_players_by_pk(id: "${rowId}") { id } }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
    });

    it("has no update or delete permission for role=administrator", async () => {
      const admin = await fx.player();
      const applicant = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", applicant, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "AdminCannotTouch", sort_order: 1 }] },
        },
      });
      const rowId = inserted.data.insert_verification_applications_one.known_players[0].id;

      const updateResult = await gql(
        `mutation { update_verification_application_known_players_by_pk(pk_columns: { id: "${rowId}" }, _set: { nickname: "Changed" }) { id } }`,
        "administrator",
        admin,
      );
      expect(updateResult.errors).toBeDefined();

      const deleteResult = await gql(
        `mutation { delete_verification_application_known_players_by_pk(id: "${rowId}") { id } }`,
        "administrator",
        admin,
      );
      expect(deleteResult.errors).toBeDefined();
    });
  });

  describe("maximum of 3 references per application is enforced at the database level", () => {
    it("rejects a 4th reference outside sort_order 1..3 via the CHECK constraint", async () => {
      const player = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: {
            data: [
              { nickname: "A", sort_order: 1 },
              { nickname: "B", sort_order: 2 },
              { nickname: "C", sort_order: 3 },
            ],
          },
        },
      });
      expect(inserted.errors).toBeUndefined();
      const applicationId = inserted.data.insert_verification_applications_one.id;

      const result = await gql(
        `mutation {
          insert_verification_application_known_players_one(object: {
            verification_application_id: "${applicationId}"
            nickname: "D"
            sort_order: 4
          }) { id }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
    });

    it("rejects a duplicate sort_order for the same application via the UNIQUE constraint", async () => {
      const player = await fx.player();
      const inserted = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "First", sort_order: 1 }] },
        },
      });
      const applicationId = inserted.data.insert_verification_applications_one.id;

      const result = await gql(
        `mutation {
          insert_verification_application_known_players_one(object: {
            verification_application_id: "${applicationId}"
            nickname: "Collides"
            sort_order: 1
          }) { id }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
    });
  });

  describe("a row must carry at least one non-blank field -- enforced by a CHECK constraint, not just client-side filtering", () => {
    it("accepts a nickname-only row", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ nickname: "NicknameOnly", sort_order: 1 }] },
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_verification_applications_one?.known_players).toEqual([
        expect.objectContaining({ nickname: "NicknameOnly", steam_profile_url: null }),
      ]);
    });

    it("accepts a Steam-URL-only row", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: {
            data: [
              {
                steam_profile_url: "https://steamcommunity.com/id/steamonly",
                sort_order: 1,
              },
            ],
          },
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_verification_applications_one?.known_players).toEqual([
        expect.objectContaining({
          nickname: null,
          steam_profile_url: "https://steamcommunity.com/id/steamonly",
        }),
      ]);
    });

    it("accepts a row with both fields set", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: {
            data: [
              {
                nickname: "Both",
                steam_profile_url: "https://steamcommunity.com/id/both",
                sort_order: 1,
              },
            ],
          },
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_verification_applications_one?.known_players).toEqual([
        expect.objectContaining({
          nickname: "Both",
          steam_profile_url: "https://steamcommunity.com/id/both",
        }),
      ]);
    });

    it("rejects a row with both fields null", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: { data: [{ sort_order: 1 }] },
        },
      });
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_verification_applications_one ?? null).toBeNull();
    });

    it("rejects a row with both fields present but blank/whitespace-only -- BTRIM catches it, not just a raw NULL check", async () => {
      const player = await fx.player();
      const result = await gql(INSERT_WITH_KNOWN_PLAYERS, "user", player, {
        object: {
          ...baseApplication(),
          known_players: {
            data: [{ nickname: "   ", steam_profile_url: "", sort_order: 1 }],
          },
        },
      });
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_verification_applications_one ?? null).toBeNull();
    });
  });

  describe("legacy single-reference data (deaf_player_nickname/deaf_player_steam_url)", () => {
    it("remains stored and selectable untouched on historical rows with no known_players", async () => {
      const applicant = await fx.player();
      await postgres.query(
        "ALTER TABLE verification_applications DISABLE TRIGGER tbi_verification_applications",
      );
      try {
        await postgres.query(
          `INSERT INTO verification_applications
             (player_steam_id, is_deaf, country, knows_deaf_player, deaf_player_nickname, deaf_player_steam_url)
           VALUES ($1, 'yes', 'US', true, 'LegacyNick', 'https://steamcommunity.com/id/legacy')`,
          [applicant],
        );
      } finally {
        await postgres.query(
          "ALTER TABLE verification_applications ENABLE TRIGGER tbi_verification_applications",
        );
      }

      const result = await gql(
        `query { verification_applications(where: { player_steam_id: { _eq: "${applicant}" } }) {
          deaf_player_nickname
          deaf_player_steam_url
          known_players { id }
        } }`,
        "user",
        applicant,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_applications).toEqual([
        {
          deaf_player_nickname: "LegacyNick",
          deaf_player_steam_url: "https://steamcommunity.com/id/legacy",
          known_players: [],
        },
      ]);
    });
  });
});
