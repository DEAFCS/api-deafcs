import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Exercises the new verification-application applicant fields (known-player
// nickname, social profile URLs, account declaration) against a real Hasura
// instance bound to the repo's hasura/metadata + hasura/triggers -- same
// harness as terms-acceptances-admin.spec.ts. Two things specifically need a
// real engine, not a static YAML read:
//
// 1. account_declaration_accepted_at is meant to be server-controlled
//    evidence, not client-supplied data -- tbi_verification_applications
//    (hasura/triggers/verification_applications.sql) is the only thing that
//    actually enforces that, by overwriting whatever the client sent with
//    now() and rejecting the insert outright if it arrives null. A static
//    metadata read can't prove the trigger behaves this way.
// 2. The new columns must be reachable through the *existing* insert/select
//    permission column whitelists without loosening the existing
//    own-row-only filter, the forced player_steam_id/status `set`, or
//    adding any update/delete permission -- again, only provable by
//    actually running mutations/queries against a live instance.
describe("Verification application applicant fields (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "verification-applicant-fields-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("VerificationApplicantFieldsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199965000000n);

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

  const INSERT_MUTATION = `
    mutation Insert($object: verification_applications_insert_input!) {
      insert_verification_applications_one(object: $object) {
        id
        found_via
        deaf_player_nickname
        social_instagram_url
        social_facebook_url
        social_vk_url
        account_declaration_accepted_at
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

  describe("account declaration is server-controlled evidence", () => {
    it("rejects an insert with no declaration timestamp at all", async () => {
      const player = await fx.player();
      const result = await gql(
        INSERT_MUTATION,
        "user",
        player,
        {
          object: {
            is_deaf: "yes",
            country: "US",
            knows_deaf_player: false,
          },
        },
      );
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toMatch(/declaration/i);
      expect(result.data?.insert_verification_applications_one ?? null).toBeNull();
    });

    it("overwrites a client-supplied declaration timestamp with the server's own clock", async () => {
      const player = await fx.player();
      // A deliberately wrong, far-future timestamp -- if the server ever
      // trusted this value verbatim, the assertion below would catch it.
      const forgedTimestamp = "2099-01-01T00:00:00.000Z";
      const before = Date.now();

      const result = await gql(
        INSERT_MUTATION,
        "user",
        player,
        {
          object: {
            is_deaf: "yes",
            country: "US",
            knows_deaf_player: false,
            account_declaration_accepted_at: forgedTimestamp,
          },
        },
      );

      expect(result.errors).toBeUndefined();
      const stored = result.data?.insert_verification_applications_one
        ?.account_declaration_accepted_at;
      expect(stored).toBeDefined();
      expect(stored).not.toBe(forgedTimestamp);
      const storedMs = new Date(stored).getTime();
      expect(storedMs).toBeGreaterThanOrEqual(before - 5000);
      expect(storedMs).toBeLessThanOrEqual(Date.now() + 5000);
    });
  });

  describe("new applicant fields round-trip through the existing insert/select permissions", () => {
    it("accepts the new fields and found_via being entirely omitted (now optional)", async () => {
      const player = await fx.player();
      const result = await gql(
        INSERT_MUTATION,
        "user",
        player,
        {
          object: {
            is_deaf: "hard_of_hearing",
            country: "DE",
            knows_deaf_player: true,
            deaf_player_nickname: "SomeNickname",
            deaf_player_steam_url: "https://steamcommunity.com/id/example",
            social_instagram_url: "https://instagram.com/example",
            social_facebook_url: "https://facebook.com/example",
            social_vk_url: "https://vk.com/example",
            account_declaration_accepted_at: new Date().toISOString(),
          },
        },
      );

      expect(result.errors).toBeUndefined();
      const row = result.data?.insert_verification_applications_one;
      expect(row.found_via).toBeNull();
      expect(row.deaf_player_nickname).toBe("SomeNickname");
      expect(row.social_instagram_url).toBe("https://instagram.com/example");
      expect(row.social_facebook_url).toBe("https://facebook.com/example");
      expect(row.social_vk_url).toBe("https://vk.com/example");
      expect(row.account_declaration_accepted_at).toBeDefined();
    });
  });

  describe("role=user own-row restriction is unchanged by the new columns", () => {
    it("can read the new fields on their own application", async () => {
      const player = await fx.player();
      await gql(INSERT_MUTATION, "user", player, {
        object: {
          is_deaf: "no",
          country: "FR",
          knows_deaf_player: false,
          social_vk_url: "https://vk.com/own-app",
          account_declaration_accepted_at: new Date().toISOString(),
        },
      });

      const result = await gql(
        `query { verification_applications(where: { player_steam_id: { _eq: "${player}" } }) {
          social_vk_url
          account_declaration_accepted_at
        } }`,
        "user",
        player,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_applications).toEqual([
        expect.objectContaining({ social_vk_url: "https://vk.com/own-app" }),
      ]);
    });

    it("still cannot read another player's application", async () => {
      const viewer = await fx.player();
      const other = await fx.player();
      await gql(INSERT_MUTATION, "user", other, {
        object: {
          is_deaf: "yes",
          country: "US",
          knows_deaf_player: false,
          account_declaration_accepted_at: new Date().toISOString(),
        },
      });

      const result = await gql(
        `query { verification_applications(where: { player_steam_id: { _eq: "${other}" } }) { id } }`,
        "user",
        viewer,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_applications).toEqual([]);
    });

    it("still cannot forge player_steam_id or status on insert", async () => {
      const player = await fx.player();
      const other = await fx.player();
      const result = await gql(
        INSERT_MUTATION.replace(
          "insert_verification_applications_one(object: $object) {",
          "insert_verification_applications_one(object: $object) { player_steam_id status",
        ),
        "user",
        player,
        {
          object: {
            player_steam_id: other,
            status: "approved",
            is_deaf: "yes",
            country: "US",
            knows_deaf_player: false,
            account_declaration_accepted_at: new Date().toISOString(),
          },
        },
      );
      // player_steam_id/status aren't in the insert columns whitelist at
      // all, so Hasura rejects the extra fields at the GraphQL-schema level
      // -- proving the client can't even attempt to set them, let alone
      // succeed.
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_verification_applications_one ?? null).toBeNull();
    });
  });

  describe("role=administrator", () => {
    it("can read the new fields on another player's application", async () => {
      const admin = await fx.player();
      const applicant = await fx.player();
      await gql(INSERT_MUTATION, "user", applicant, {
        object: {
          is_deaf: "yes",
          country: "BR",
          knows_deaf_player: true,
          deaf_player_nickname: "AdminVisibleNick",
          social_facebook_url: "https://facebook.com/admin-visible",
          account_declaration_accepted_at: new Date().toISOString(),
        },
      });

      const result = await gql(
        `query { verification_applications(where: { player_steam_id: { _eq: "${applicant}" } }) {
          deaf_player_nickname
          social_facebook_url
          account_declaration_accepted_at
        } }`,
        "administrator",
        admin,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.verification_applications).toEqual([
        expect.objectContaining({
          deaf_player_nickname: "AdminVisibleNick",
          social_facebook_url: "https://facebook.com/admin-visible",
        }),
      ]);
    });

    it("has no update permission on verification_applications", async () => {
      const admin = await fx.player();
      const applicant = await fx.player();
      const inserted = await gql(INSERT_MUTATION, "user", applicant, {
        object: {
          is_deaf: "yes",
          country: "BR",
          knows_deaf_player: false,
          account_declaration_accepted_at: new Date().toISOString(),
        },
      });
      const id = inserted.data.insert_verification_applications_one.id;

      const result = await gql(
        `mutation { update_verification_applications_by_pk(pk_columns: { id: "${id}" }, _set: { country: "US" }) { id } }`,
        "administrator",
        admin,
      );
      expect(result.errors).toBeDefined();
    });

    it("has no update permission for role=user either", async () => {
      const applicant = await fx.player();
      const inserted = await gql(INSERT_MUTATION, "user", applicant, {
        object: {
          is_deaf: "yes",
          country: "BR",
          knows_deaf_player: false,
          account_declaration_accepted_at: new Date().toISOString(),
        },
      });
      const id = inserted.data.insert_verification_applications_one.id;

      const result = await gql(
        `mutation { update_verification_applications_by_pk(pk_columns: { id: "${id}" }, _set: { country: "US" }) { id } }`,
        "user",
        applicant,
      );
      expect(result.errors).toBeDefined();
    });
  });

  describe("historical rows predating these columns", () => {
    it("remain fully valid and selectable with NULL in every new column", async () => {
      const applicant = await fx.player();

      // Simulates a row inserted before tbi_verification_applications and
      // the new columns existed: disable the trigger (which would otherwise
      // reject a null declaration on any new insert) to seed a historical
      // row exactly like the ones already in production, then restore it.
      await postgres.query(
        "ALTER TABLE verification_applications DISABLE TRIGGER tbi_verification_applications",
      );
      try {
        await postgres.query(
          `INSERT INTO verification_applications
             (player_steam_id, is_deaf, country, found_via, knows_deaf_player)
           VALUES ($1, 'yes', 'US', 'discord', false)`,
          [applicant],
        );
      } finally {
        await postgres.query(
          "ALTER TABLE verification_applications ENABLE TRIGGER tbi_verification_applications",
        );
      }

      const asOwner = await gql(
        `query { verification_applications(where: { player_steam_id: { _eq: "${applicant}" } }) {
          deaf_player_nickname
          social_instagram_url
          social_facebook_url
          social_vk_url
          account_declaration_accepted_at
        } }`,
        "user",
        applicant,
      );
      expect(asOwner.errors).toBeUndefined();
      expect(asOwner.data?.verification_applications).toEqual([
        {
          deaf_player_nickname: null,
          social_instagram_url: null,
          social_facebook_url: null,
          social_vk_url: null,
          account_declaration_accepted_at: null,
        },
      ]);
    });
  });
});
