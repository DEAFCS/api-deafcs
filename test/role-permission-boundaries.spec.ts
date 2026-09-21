import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

describe("role permission boundaries (direct Hasura requests)", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let fx: Fixtures;
  const adminSecret = "role-boundaries-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("RolePermissionBoundariesTest");
    fx = new Fixtures(db.postgres, 76561199991000000n);

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
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

  async function graphql(
    role: string,
    steamId: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
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
    return response.json();
  }

  async function createTournament(
    organizerSteamId: string,
    name: string,
  ): Promise<string> {
    const matchOptionsId = await fx.matchOptions();
    const [row] = await db.postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
         (name, start, organizer_steam_id, match_options_id, status, min_role)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL)
       RETURNING id`,
      [name, organizerSteamId, matchOptionsId],
    );
    return row.id;
  }

  it("loads consistent metadata", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    expect(await response.json()).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("fails closed at Tournament Organizer when the creation setting is missing or low", async () => {
    const mutation = `mutation Create($object: tournaments_insert_input!) {
      insert_tournaments_one(object: $object) { id organizer_steam_id }
    }`;

    for (const setting of [null, "user", "moderator"]) {
      const matchOptionsId = await fx.matchOptions();
      if (setting === null) {
        await db.postgres.query(
          "DELETE FROM settings WHERE name = 'public.create_tournaments_role'",
        );
      } else {
        await db.postgres.query(
          `INSERT INTO settings (name, value) VALUES ('public.create_tournaments_role', $1)
           ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
          [setting],
        );
      }

      for (const role of [
        "verified_user",
        "streamer",
        "moderator",
        "match_organizer",
      ]) {
        const player = await fx.player();
        const result = await graphql(role, player, mutation, {
          object: {
            name: `Denied ${role}`,
            start: new Date(Date.now() + 86_400_000).toISOString(),
            match_options_id: matchOptionsId,
          },
        });
        expect(result.errors).toBeDefined();
        expect(result.data?.insert_tournaments_one ?? null).toBeNull();
      }

      const organizer = await fx.player();
      const allowed = await graphql(
        "tournament_organizer",
        organizer,
        mutation,
        {
          object: {
            name: `Allowed ${setting ?? "missing"}`,
            start: new Date(Date.now() + 86_400_000).toISOString(),
            match_options_id: matchOptionsId,
          },
        },
      );
      expect(allowed.errors).toBeUndefined();
      expect(allowed.data?.insert_tournaments_one.organizer_steam_id).toBe(
        organizer,
      );
    }

    await db.postgres.query(
      `INSERT INTO settings (name, value)
       VALUES ('public.create_tournaments_role', 'tournament_organizer')
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    );
  });

  it("preserves the Administrator-only tournament creation setting", async () => {
    await db.postgres.query(
      `UPDATE settings SET value = 'administrator'
        WHERE name = 'public.create_tournaments_role'`,
    );
    const matchOptionsId = await fx.matchOptions();
    const mutation = `mutation Create($object: tournaments_insert_input!) {
      insert_tournaments_one(object: $object) { id }
    }`;
    const object = {
      name: "Admin-only cup",
      start: new Date(Date.now() + 86_400_000).toISOString(),
      match_options_id: matchOptionsId,
    };

    const organizer = await graphql(
      "tournament_organizer",
      await fx.player(),
      mutation,
      { object },
    );
    const administrator = await graphql(
      "administrator",
      await fx.player(),
      mutation,
      { object: { ...object, name: "Administrator cup" } },
    );

    expect(organizer.errors).toBeDefined();
    expect(administrator.errors).toBeUndefined();
  });

  it("scopes tournament management to creator and assigned organizers", async () => {
    const creator = await fx.player();
    const assigned = await fx.player();
    const outsider = await fx.player();
    const tournamentId = await createTournament(creator, "Ownership cup");
    await db.postgres.query(
      `INSERT INTO tournament_organizers (tournament_id, steam_id)
       VALUES ($1, $2)`,
      [tournamentId, assigned],
    );

    const mutation = `mutation Rename($id: uuid!, $name: String!) {
      update_tournaments_by_pk(pk_columns: { id: $id }, _set: { name: $name }) { id name }
    }`;
    const own = await graphql("tournament_organizer", creator, mutation, {
      id: tournamentId,
      name: "Creator managed",
    });
    const assignedResult = await graphql(
      "tournament_organizer",
      assigned,
      mutation,
      { id: tournamentId, name: "Assigned managed" },
    );
    const denied = await graphql("tournament_organizer", outsider, mutation, {
      id: tournamentId,
      name: "Outsider managed",
    });

    expect(own.data?.update_tournaments_by_pk?.name).toBe("Creator managed");
    expect(assignedResult.data?.update_tournaments_by_pk?.name).toBe(
      "Assigned managed",
    );
    expect(denied.data?.update_tournaments_by_pk).toBeNull();
    const [row] = await db.postgres.query<Array<{ name: string }>>(
      "SELECT name FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    expect(row.name).toBe("Assigned managed");
  });

  it("blocks Moderator and Tournament Organizer player role escalation and deletion", async () => {
    for (const role of ["moderator", "tournament_organizer"]) {
      const actor = await fx.player();
      const target = await fx.player(undefined, { acceptTerms: false });
      const elevate = await graphql(
        role,
        actor,
        `mutation { update_players_by_pk(pk_columns: { steam_id: "${target}" }, _set: { role: administrator }) { role } }`,
      );
      const remove = await graphql(
        role,
        actor,
        `mutation { delete_players_by_pk(steam_id: "${target}") { steam_id } }`,
      );
      expect(elevate.errors).toBeDefined();
      expect(remove.errors).toBeDefined();
    }

    const admin = await fx.player();
    const target = await fx.player(undefined, { acceptTerms: false });
    const elevated = await graphql(
      "administrator",
      admin,
      `mutation { update_players_by_pk(pk_columns: { steam_id: "${target}" }, _set: { role: moderator }) { role } }`,
    );
    expect(elevated.data?.update_players_by_pk?.role).toBe("moderator");
  });

  it("lets Moderator review and reply to verification applications but not delete them", async () => {
    const applicant = await fx.player();
    const moderator = await fx.player();
    const [application] = await db.postgres.query<Array<{ id: string }>>(
      `INSERT INTO verification_applications
         (player_steam_id, is_deaf, country, found_via,
          account_declaration_accepted_at)
       VALUES ($1, 'yes', 'DK', 'community', now()) RETURNING id`,
      [applicant],
    );

    const selected = await graphql(
      "moderator",
      moderator,
      `query { verification_applications_by_pk(id: "${application.id}") { id status } }`,
    );
    const replied = await graphql(
      "moderator",
      moderator,
      `mutation { insert_verification_application_messages_one(object: { application_id: "${application.id}", message: "Please provide more detail." }) { is_admin sender_steam_id } }`,
    );
    const deleted = await graphql(
      "moderator",
      moderator,
      `mutation { delete_verification_applications_by_pk(id: "${application.id}") { id } }`,
    );

    expect(selected.data?.verification_applications_by_pk?.id).toBe(
      application.id,
    );
    expect(replied.data?.insert_verification_application_messages_one).toEqual({
      is_admin: true,
      sender_steam_id: moderator,
    });
    expect(deleted.errors).toBeDefined();
  });

  // Regression for a real production incident: verification/support-request
  // submissions broadcast as role: "moderator" (notifications.service.ts
  // send()), but Administrator's own select/update permission on
  // notifications still literally required role = administrator, unchanged
  // since before that role existed. Administrators never saw the alert in
  // the panel even though push notifications (which resolve visibility via
  // isRoleAbove, not this literal Hasura filter) reached their phone --
  // confirmed live via a direct admin-secret-authenticated query against
  // production before this fix. Administrator must see (and be able to mark
  // read) anything Moderator sees, without granting Match Organizer,
  // Tournament Organizer, or an ordinary player any new visibility, and
  // without leaking another player's own targeted notifications.
  it("lets Administrator see and act on Moderator-broadcast notifications, without widening any other role", async () => {
    const [broadcast] = await db.postgres.query<Array<{ id: string }>>(
      `INSERT INTO notifications (title, message, role, type, entity_id)
       VALUES ('New verification application', 'test', 'moderator',
               'VerificationApplicationSubmitted', 'test-entity-1')
       RETURNING id`,
    );

    const admin = await fx.player();
    const moderator = await fx.player();
    const matchOrganizer = await fx.player();
    const tournamentOrganizer = await fx.player();
    const ordinaryPlayer = await fx.player();

    const query = `query($id: uuid!) { notifications_by_pk(id: $id) { id role } }`;
    for (const [role, steamId, shouldSee] of [
      ["administrator", admin, true],
      ["moderator", moderator, true],
      ["match_organizer", matchOrganizer, false],
      ["tournament_organizer", tournamentOrganizer, false],
      ["user", ordinaryPlayer, false],
    ] as const) {
      const result = await graphql(role, steamId, query, { id: broadcast.id });
      expect(result.data?.notifications_by_pk?.id ?? null).toBe(
        shouldSee ? broadcast.id : null,
      );
    }

    // Administrator must also be able to mark it read (update_permissions),
    // not just select it.
    const markRead = await graphql(
      "administrator",
      admin,
      `mutation($id: uuid!) {
        update_notifications_by_pk(pk_columns: { id: $id }, _set: { is_read: true }) {
          is_read
        }
      }`,
      { id: broadcast.id },
    );
    expect(markRead.data?.update_notifications_by_pk?.is_read).toBe(true);

    // A different player's own targeted notification stays private -- this
    // fix must not have broadened anything beyond the moderator broadcast.
    const [targeted] = await db.postgres.query<Array<{ id: string }>>(
      `INSERT INTO notifications (title, message, role, type, entity_id, steam_id)
       VALUES ('Your application', 'test', 'user',
               'VerificationApplicationReviewed', 'test-entity-2', $1)
       RETURNING id`,
      [ordinaryPlayer],
    );
    const otherPlayer = await fx.player();
    const leaked = await graphql("user", otherPlayer, query, {
      id: targeted.id,
    });
    expect(leaked.data?.notifications_by_pk).toBeNull();
  });
});
