import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// The team computed fields (can_remove / can_change_role) have always said a
// site administrator may moderate any team, but Hasura's table permissions only
// covered the "user" role (owner / team Admin): an administrator's delete or
// update matched no row and Hasura answered null instead of an error. These
// run REAL GraphQL against a real Hasura engine and the real migrated database,
// as each role, to prove what is and is not allowed. The last-Admin invariant
// stays with the database triggers: a site administrator does not bypass it.
const LAST_ADMIN_MESSAGE =
  "You are the last team Admin. Assign another Admin before changing your role or leaving the team.";

describe("team moderation by role (real Hasura)", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let fx: Fixtures;
  let siteAdmin: string;
  let stranger: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TeamSiteAdminModeration");
    fx = new Fixtures(db.postgres, 76561199710000000n);

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
    siteAdmin = await fx.player("SiteAdmin");
    stranger = await fx.player("Stranger");
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

  it("loads with consistent Hasura metadata", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": "metadata-test" },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    const body = (await response.json()) as { is_consistent: boolean; inconsistent_objects: any[] };
    expect(body.inconsistent_objects).toEqual([]);
    expect(body.is_consistent).toBe(true);
  });

  const DELETE_TEAM = `mutation ($id: uuid!) { delete_teams_by_pk(id: $id) { id } }`;
  const DELETE_MEMBER = `mutation ($t: uuid!, $p: bigint!) {
    delete_team_roster_by_pk(team_id: $t, player_steam_id: $p) { team_id }
  }`;
  const SET_ROLE = (role: string) => `mutation ($t: uuid!, $p: bigint!) {
    update_team_roster_by_pk(pk_columns: { team_id: $t, player_steam_id: $p }, _set: { role: ${role} }) { role }
  }`;
  const SET_STATUS = `mutation ($t: uuid!, $p: bigint!) {
    update_team_roster_by_pk(pk_columns: { team_id: $t, player_steam_id: $p }, _set: { status: Benched, coach: true }) { status coach }
  }`;

  // owner (Admin), a second Admin, and four members in different slots.
  async function buildTeam() {
    const team = await fx.team(0);
    const [secondAdmin, starter, sub, bench, coach, member] = [
      await fx.player(),
      await fx.player(),
      await fx.player(),
      await fx.player(),
      await fx.player(),
      await fx.player(),
    ];
    const add = async (steam: string, status: string, role = "Member", coachFlag = false) => {
      await runAsUser(db.postgres, team.owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status, coach) VALUES ($1, $2, $3, $4)",
          [team.id, steam, status, coachFlag],
        ),
      );
      if (role === "Admin") {
        await runAsUser(db.postgres, team.owner, "admin", (query) =>
          query(
            "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
            [team.id, steam],
          ),
        );
      }
    };
    // Inserted as a site "admin" session, the way the fixtures do (the invite
    // trigger only intercepts ordinary sessions); the role is set afterwards.
    await add(secondAdmin, "Starter", "Admin");
    await add(starter, "Starter");
    await add(sub, "Substitute");
    await add(bench, "Benched");
    await add(coach, "Benched", "Member", true);
    await add(member, "Substitute");
    return { ...team, secondAdmin, starter, sub, bench, coach, member };
  }

  const rosterRow = async (teamId: string, steam: string) =>
    (
      await db.postgres.query<Array<{ role: string; status: string; coach: boolean }>>(
        "SELECT role, status, coach FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, steam],
      )
    )[0];
  const teamExists = async (teamId: string) =>
    (await db.postgres.query("SELECT 1 FROM teams WHERE id = $1", [teamId])).length === 1;
  const captainOf = async (teamId: string) =>
    (
      await db.postgres.query<Array<{ captain_steam_id: string | null }>>(
        "SELECT captain_steam_id FROM teams WHERE id = $1",
        [teamId],
      )
    )[0].captain_steam_id;

  describe("deleting a team", () => {
    it("lets the owner delete their own team", async () => {
      const team = await buildTeam();
      const result = await graphql("user", team.owner, DELETE_TEAM, { id: team.id });
      expect(result.errors).toBeUndefined();
      expect(result.data.delete_teams_by_pk).toEqual({ id: team.id });
      expect(await teamExists(team.id)).toBe(false);
    });

    it("lets a site administrator delete any team", async () => {
      const team = await buildTeam();
      const result = await graphql("administrator", siteAdmin, DELETE_TEAM, { id: team.id });
      expect(result.errors).toBeUndefined();
      expect(result.data.delete_teams_by_pk).toEqual({ id: team.id });
      expect(await teamExists(team.id)).toBe(false);
    });

    it("does not let an unrelated user, a member or even a second team Admin delete it", async () => {
      const team = await buildTeam();
      for (const [role, id] of [
        ["user", stranger],
        ["user", team.member],
        ["user", team.secondAdmin],
        ["tournament_organizer", stranger],
      ] as const) {
        const result = await graphql(role, id, DELETE_TEAM, { id: team.id });
        expect(result.data?.delete_teams_by_pk ?? null).toBeNull();
      }
      expect(await teamExists(team.id)).toBe(true);
    });
  });

  describe("removing members", () => {
    it.each([
      ["a member", "member"],
      ["a starter", "starter"],
      ["a substitute", "sub"],
      ["a benched player", "bench"],
      ["a coach", "coach"],
    ] as const)("lets a site administrator remove %s", async (_label, key) => {
      const team = await buildTeam();
      const target = team[key];
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: target });
      expect(result.errors).toBeUndefined();
      // (a bigint steam id would lose precision as a JSON number: read the team)
      expect(result.data.delete_team_roster_by_pk).toEqual({ team_id: team.id });
      expect(await rosterRow(team.id, target)).toBeUndefined();
    });

    it("lets a site administrator remove a non-last Admin", async () => {
      const team = await buildTeam();
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: team.secondAdmin });
      expect(result.errors).toBeUndefined();
      expect(await rosterRow(team.id, team.secondAdmin)).toBeUndefined();
    });

    it("keeps the existing owner / team Admin removal", async () => {
      const team = await buildTeam();
      for (const [actor, target] of [
        [team.owner, team.member],
        [team.secondAdmin, team.bench],
      ]) {
        const result = await graphql("user", actor, DELETE_MEMBER, { t: team.id, p: target });
        expect(result.errors).toBeUndefined();
        expect(await rosterRow(team.id, target)).toBeUndefined();
      }
    });

    it("blocks everyone else: strangers, members and the wrong site role", async () => {
      const team = await buildTeam();
      for (const [role, id] of [
        ["user", stranger],
        ["user", team.starter],
        ["tournament_organizer", stranger],
      ] as const) {
        const result = await graphql(role, id, DELETE_MEMBER, { t: team.id, p: team.member });
        expect(result.data?.delete_team_roster_by_pk ?? null).toBeNull();
      }
      expect(await rosterRow(team.id, team.member)).toBeDefined();
    });
  });

  describe("changing roles and slots", () => {
    it("lets a site administrator promote a member to Admin and set a slot or coach", async () => {
      const team = await buildTeam();
      const promote = await graphql("administrator", siteAdmin, SET_ROLE("Admin"), { t: team.id, p: team.member });
      expect(promote.errors).toBeUndefined();
      expect(promote.data.update_team_roster_by_pk).toEqual({ role: "Admin" });
      expect((await rosterRow(team.id, team.member)).role).toBe("Admin");

      const slot = await graphql("administrator", siteAdmin, SET_STATUS, { t: team.id, p: team.starter });
      expect(slot.errors).toBeUndefined();
      expect(slot.data.update_team_roster_by_pk).toEqual({ status: "Benched", coach: true });
    });

    it("lets a site administrator demote an Admin while another remains", async () => {
      const team = await buildTeam();
      const result = await graphql("administrator", siteAdmin, SET_ROLE("Member"), { t: team.id, p: team.secondAdmin });
      expect(result.errors).toBeUndefined();
      expect((await rosterRow(team.id, team.secondAdmin)).role).toBe("Member");
    });

    it("still keeps roster_image_url out of reach, even for a site administrator", async () => {
      const team = await buildTeam();
      const result = await graphql(
        "administrator",
        siteAdmin,
        `mutation ($t: uuid!, $p: bigint!) {
          update_team_roster_by_pk(pk_columns: { team_id: $t, player_steam_id: $p }, _set: { roster_image_url: "x" }) { roster_image_url }
        }`,
        { t: team.id, p: team.member },
      );
      expect(result.errors).toBeDefined();
      expect((await rosterRow(team.id, team.member)).status).toBeDefined();
    });

    it("blocks unauthorized role changes", async () => {
      const team = await buildTeam();
      for (const [role, id] of [
        ["user", stranger],
        ["user", team.starter],
        ["tournament_organizer", stranger],
      ] as const) {
        const result = await graphql(role, id, SET_ROLE("Admin"), { t: team.id, p: team.member });
        expect(result.data?.update_team_roster_by_pk ?? null).toBeNull();
      }
      expect((await rosterRow(team.id, team.member)).role).toBe("Member");
    });
  });

  describe("the last-Admin invariant holds for site administrators too", () => {
    async function soleAdminTeam() {
      const team = await buildTeam();
      await db.postgres.query(
        "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, team.secondAdmin],
      );
      return team; // the owner is the only Admin
    }

    it("blocks removing the only Admin", async () => {
      const team = await soleAdminTeam();
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: team.owner });
      expect(JSON.stringify(result.errors)).toContain(LAST_ADMIN_MESSAGE);
      expect(await rosterRow(team.id, team.owner)).toBeDefined();
    });

    it("blocks demoting the only Admin", async () => {
      const team = await soleAdminTeam();
      const result = await graphql("administrator", siteAdmin, SET_ROLE("Member"), { t: team.id, p: team.owner });
      expect(JSON.stringify(result.errors)).toContain(LAST_ADMIN_MESSAGE);
      expect((await rosterRow(team.id, team.owner)).role).toBe("Admin");
    });

    it("blocks the owner and a team Admin from removing the only Admin as well", async () => {
      const team = await soleAdminTeam();
      const result = await graphql("user", team.owner, DELETE_MEMBER, { t: team.id, p: team.owner });
      expect(JSON.stringify(result.errors)).toContain(LAST_ADMIN_MESSAGE);
    });

    it("still allows deleting the whole team (a deliberate disband)", async () => {
      const team = await soleAdminTeam();
      const result = await graphql("administrator", siteAdmin, DELETE_TEAM, { id: team.id });
      expect(result.errors).toBeUndefined();
      expect(await teamExists(team.id)).toBe(false);
    });
  });

  describe("removing the captain leaves a valid captain reference", () => {
    it("hands the captaincy to the owner when a non-owner captain is removed", async () => {
      const team = await buildTeam();
      await db.postgres.query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [team.id, team.starter]);
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: team.starter });
      expect(result.errors).toBeUndefined();
      expect(await rosterRow(team.id, team.starter)).toBeUndefined();
      expect(await captainOf(team.id)).toBe(team.owner);
    });

    it("clears the captain when the owner is the captain and leaves the roster", async () => {
      const team = await buildTeam();
      await db.postgres.query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [team.id, team.owner]);
      // another Admin remains, so removing the owner's row is allowed
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: team.owner });
      expect(result.errors).toBeUndefined();
      expect(await captainOf(team.id)).toBeNull();
    });

    it("works the same when a team Admin removes the captain", async () => {
      const team = await buildTeam();
      await db.postgres.query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [team.id, team.member]);
      const result = await graphql("user", team.secondAdmin, DELETE_MEMBER, { t: team.id, p: team.member });
      expect(result.errors).toBeUndefined();
      expect(await captainOf(team.id)).toBe(team.owner);
    });

    it("blocks removing a captain who is also the last Admin, and keeps the captain", async () => {
      const team = await buildTeam();
      // The starter becomes an Admin first, then the other two stop being one.
      await db.postgres.query("UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2", [team.id, team.starter]);
      await db.postgres.query(
        "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id IN ($2, $3)",
        [team.id, team.owner, team.secondAdmin],
      );
      await db.postgres.query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [team.id, team.starter]);
      const result = await graphql("administrator", siteAdmin, DELETE_MEMBER, { t: team.id, p: team.starter });
      expect(JSON.stringify(result.errors)).toContain(LAST_ADMIN_MESSAGE);
      expect(await captainOf(team.id)).toBe(team.starter);
    });
  });

  describe("teams.created_at", () => {
    const FOUNDED = `query ($id: uuid!) { teams_by_pk(id: $id) { id created_at } }`;

    it("stamps every new team", async () => {
      const before = Date.now() - 5_000;
      const team = await buildTeam();
      const result = await graphql("administrator", siteAdmin, FOUNDED, { id: team.id });
      expect(result.errors).toBeUndefined();
      const createdAt = new Date(result.data.teams_by_pk.created_at).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(Date.now() + 5_000);
    });

    it("is readable by guests, users and administrators, and may be null", async () => {
      const team = await buildTeam();
      await db.postgres.query("UPDATE teams SET created_at = NULL WHERE id = $1", [team.id]);
      for (const [role, id] of [
        ["guest", null],
        ["user", stranger],
        ["administrator", siteAdmin],
      ] as const) {
        const result = await graphql(role, id, FOUNDED, { id: team.id });
        expect(result.errors).toBeUndefined();
        expect(result.data.teams_by_pk).toEqual({ id: team.id, created_at: null });
      }
    });

    it("cannot be written through GraphQL", async () => {
      const team = await buildTeam();
      for (const [role, id] of [
        ["user", team.owner],
        ["administrator", siteAdmin],
      ] as const) {
        const result = await graphql(
          role,
          id,
          `mutation ($id: uuid!) { update_teams_by_pk(pk_columns: { id: $id }, _set: { created_at: "2001-01-01T00:00:00Z" }) { id } }`,
          { id: team.id },
        );
        expect(result.errors).toBeDefined();
      }
    });
  });
});
