import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootContainerAndMigrate,
  runAsUser,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Who may add and remove a player (a substitute) on a registered team's
// TOURNAMENT roster, through the real Hasura permissions (raw SQL bypasses
// them). Managing a team means the same people for both directions:
//
//   add and remove   team owner, team Admin, team captain, tournament roster
//                    Admin, tournament organizer / co-organizer, site Admin
//   remove only      the player themselves
//
// Member, Invite and unrelated users can do neither. The locks are separate
// and unchanged: adding is open only in Setup / RegistrationOpen (the
// organizer role is not bound to that window); removing is closed once the
// tournament is Finished or Cancelled, and for everyone but organizer-role
// sessions once it is Live. The database still refuses any removal that would
// leave a seeded team below the starting lineup.
describe("substitute roster add/remove permissions (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "substitute-roster-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("SubstituteRosterPermissionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199975000000n);
    tournaments = new TournamentFixtures(postgres, fx);

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

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  it("has zero inconsistent metadata objects (including the manual MVP actions)", async () => {
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

  const gql = async (query: string, role: string, steamId: string) => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({ query }),
    });
    return (await response.json()) as {
      data?: any;
      errors?: Array<{ message: string }>;
    };
  };

  const verified = async () => {
    const steam = await fx.player();
    await postgres.query(
      "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
      [steam],
    );
    return steam;
  };

  const asAdmin = (sql: string, params: unknown[], by: string) =>
    runAsUser(postgres, by, "admin", (query) => query(sql, params));

  type Scenario = {
    tournamentId: string;
    organizer: string;
    ttId: string;
    teamId: string;
    owner: string;
    teamAdmin: string;
    captain: string;
    member: string;
    invite: string;
    rosterAdmin: string;
    substitute: string;
    candidate: string;
    siteAdmin: string;
    unrelated: string;
  };

  // A registered Competitive team (allowance 2) with five starters on the
  // tournament roster and one substitute already on it, plus a seventh player
  // who is not on any roster yet (the candidate for "add").
  const scenario = async (): Promise<Scenario> => {
    const t = await tournaments.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      "Competitive",
    );
    await postgres.query(
      `UPDATE match_options SET number_of_substitutes = 2
        WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    await postgres.query(
      "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
      [t.organizer],
    );

    const owner = await verified();
    const [team] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("team"), owner],
    );
    const addToTeam = async (role: "Admin" | "Member" | "Invite") => {
      const steam = await verified();
      await asAdmin(
        "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
        [team.id, steam],
        owner,
      );
      if (role !== "Member") {
        await asAdmin(
          "UPDATE team_roster SET role = $3 WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, steam, role],
          owner,
        );
      }
      return steam;
    };
    const teamAdmin = await addToTeam("Admin");
    const captain = await addToTeam("Member");
    const member = await addToTeam("Member");
    const rosterAdmin = await addToTeam("Member");
    const invite = await addToTeam("Invite");
    await asAdmin(
      "UPDATE teams SET captain_steam_id = $2 WHERE id = $1",
      [team.id, captain],
      owner,
    );

    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    const ttId = await tournaments.registerTeam(t.id, { id: team.id, owner });

    // Registration auto-fills the tournament roster from the whole team; the
    // Invite is not a playing member, so take them off it to leave exactly the
    // five starters.
    await asAdmin(
      "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
      [ttId, invite],
      owner,
    );

    // The substitute: a sixth player on the tournament roster only.
    const substitute = await verified();
    await asAdmin(
      "INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id) VALUES ($1, $2, $3)",
      [ttId, substitute, t.id],
      owner,
    );
    // One roster member is made a tournament roster Admin.
    await asAdmin(
      "UPDATE tournament_team_roster SET role = 'Admin' WHERE tournament_team_id = $1 AND player_steam_id = $2",
      [ttId, rosterAdmin],
      owner,
    );

    return {
      tournamentId: t.id,
      organizer: t.organizer,
      ttId,
      teamId: team.id,
      owner,
      teamAdmin,
      captain,
      member,
      invite,
      rosterAdmin,
      substitute,
      candidate: await verified(),
      siteAdmin: await verified(),
      unrelated: await verified(),
    };
  };

  const insertRoster = (
    s: Scenario,
    role: string,
    actor: string,
    player: string,
  ) =>
    gql(
      `mutation { insert_tournament_team_roster_one(object: {
         tournament_team_id: "${s.ttId}"
         player_steam_id: "${player}"
         tournament_id: "${s.tournamentId}"
       }) { player_steam_id } }`,
      role,
      actor,
    );

  const deleteRoster = (
    s: Scenario,
    role: string,
    actor: string,
    player: string,
  ) =>
    gql(
      `mutation { delete_tournament_team_roster(where: {
         tournament_team_id: { _eq: "${s.ttId}" }
         player_steam_id: { _eq: "${player}" }
       }) { affected_rows } }`,
      role,
      actor,
    );

  const rosterHas = async (s: Scenario, player: string) =>
    (
      await postgres.query<Array<unknown>>(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [s.ttId, player],
      )
    ).length === 1;

  const actors = (s: Scenario) =>
    [
      ["Owner", s.owner, "verified_user", true],
      ["Team Admin", s.teamAdmin, "verified_user", true],
      ["Captain", s.captain, "verified_user", true],
      ["Member", s.member, "verified_user", false],
      ["Invite", s.invite, "verified_user", false],
      ["Tournament roster Admin", s.rosterAdmin, "verified_user", true],
      ["Tournament organizer", s.organizer, "tournament_organizer", true],
      ["Site Admin", s.siteAdmin, "administrator", true],
      ["Unrelated user", s.unrelated, "verified_user", false],
    ] as const;

  describe("adding a substitute while registration is open", () => {
    it.each([
      ["Owner", true],
      ["Team Admin", true],
      ["Captain", true],
      ["Member", false],
      ["Invite", false],
      ["Tournament roster Admin", true],
      ["Tournament organizer", true],
      ["Site Admin", true],
      ["Unrelated user", false],
    ])("%s: allowed = %s", async (name, allowed) => {
      const s = await scenario();
      const [, actor, role] = actors(s).find(([n]) => n === name)!;

      const result = await insertRoster(s, role, actor, s.candidate);

      if (allowed) {
        expect(result.errors).toBeUndefined();
        expect(await rosterHas(s, s.candidate)).toBe(true);
      } else {
        expect(result.errors).toBeDefined();
        expect(await rosterHas(s, s.candidate)).toBe(false);
      }
    });

    it("the substitute cap still applies: a team already at 5 + 2 cannot take an eighth", async () => {
      const s = await scenario();
      const second = await verified();
      await asAdmin(
        "INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id) VALUES ($1, $2, $3)",
        [s.ttId, second, s.tournamentId],
        s.owner,
      );
      const result = await insertRoster(
        s,
        "verified_user",
        s.owner,
        s.candidate,
      );
      expect(result.errors?.[0].message).toMatch(/too many players/i);
      expect(await rosterHas(s, s.candidate)).toBe(false);
    });
  });

  describe("removing a substitute while registration is open", () => {
    // Removal is open to the same people who may add a player.
    it.each([
      ["Owner", true],
      ["Team Admin", true],
      ["Captain", true],
      ["Member", false],
      ["Invite", false],
      ["Tournament roster Admin", true],
      ["Tournament organizer", true],
      ["Site Admin", true],
      ["Unrelated user", false],
    ])("%s: allowed = %s", async (name, allowed) => {
      const s = await scenario();
      const [, actor, role] = actors(s).find(([n]) => n === name)!;

      const result = await deleteRoster(s, role, actor, s.substitute);

      expect(result.errors).toBeUndefined();
      expect(result.data.delete_tournament_team_roster.affected_rows).toBe(
        allowed ? 1 : 0,
      );
      expect(await rosterHas(s, s.substitute)).toBe(!allowed);
    });

    it("the substitute can remove themselves", async () => {
      const s = await scenario();
      const result = await deleteRoster(
        s,
        "verified_user",
        s.substitute,
        s.substitute,
      );
      expect(result.data.delete_tournament_team_roster.affected_rows).toBe(1);
      expect(await rosterHas(s, s.substitute)).toBe(false);
    });

    it("a substitute cannot remove another player", async () => {
      const s = await scenario();
      const result = await deleteRoster(
        s,
        "verified_user",
        s.substitute,
        s.member,
      );
      expect(result.data.delete_tournament_team_roster.affected_rows).toBe(0);
      expect(await rosterHas(s, s.member)).toBe(true);
    });

    it("the existing minimum-lineup guard is unchanged: the roster cannot drop below 5 once the draw is published", async () => {
      const s = await scenario();
      await tournaments.setStatus(
        s.tournamentId,
        s.organizer,
        "RegistrationClosed",
      );
      // 6 on the roster: removing the substitute leaves 5, which is allowed.
      const first = await deleteRoster(
        s,
        "tournament_organizer",
        s.organizer,
        s.substitute,
      );
      expect(first.data.delete_tournament_team_roster.affected_rows).toBe(1);
      // Removing a starter now would leave 4.
      const second = await deleteRoster(
        s,
        "tournament_organizer",
        s.organizer,
        s.member,
      );
      expect(second.errors?.[0].message).toMatch(/below the minimum lineup/i);
      expect(await rosterHas(s, s.member)).toBe(true);
    });
  });

  describe("once registration has closed", () => {
    it("owner, team Admin, captain and roster Admin can no longer add; only the organizer role can", async () => {
      const s = await scenario();
      await tournaments.setStatus(
        s.tournamentId,
        s.organizer,
        "RegistrationClosed",
      );

      for (const [name, actor, role, wasAllowed] of actors(s)) {
        if (
          !wasAllowed ||
          name === "Tournament organizer" ||
          name === "Site Admin"
        ) {
          continue;
        }
        const result = await insertRoster(s, role, actor, s.candidate);
        expect({ name, denied: !!result.errors }).toEqual({
          name,
          denied: true,
        });
      }
      expect(await rosterHas(s, s.candidate)).toBe(false);

      const organizer = await insertRoster(
        s,
        "tournament_organizer",
        s.organizer,
        s.candidate,
      );
      expect(organizer.errors).toBeUndefined();
      expect(await rosterHas(s, s.candidate)).toBe(true);
    });

    it("the team owner, Admin and captain can still remove the substitute while the roster stays at the starting size or above", async () => {
      for (const name of ["Owner", "Team Admin", "Captain"]) {
        const s = await scenario();
        await tournaments.setStatus(
          s.tournamentId,
          s.organizer,
          "RegistrationClosed",
        );
        const [, actor, role] = actors(s).find(([n]) => n === name)!;

        const result = await deleteRoster(s, role, actor, s.substitute);

        expect({
          name,
          removed: result.data?.delete_tournament_team_roster.affected_rows,
        }).toEqual({
          name,
          removed: 1,
        });
      }
    });

    it("the minimum-lineup guard still stops every one of them from dropping the team below five", async () => {
      for (const name of [
        "Owner",
        "Team Admin",
        "Captain",
        "Tournament roster Admin",
        "Tournament organizer",
        "Site Admin",
      ]) {
        const s = await scenario();
        await tournaments.setStatus(
          s.tournamentId,
          s.organizer,
          "RegistrationClosed",
        );
        const [, actor, role] = actors(s).find(([n]) => n === name)!;

        // Six on the roster: the substitute may go, a starter may not follow.
        const first = await deleteRoster(s, role, actor, s.substitute);
        expect(first.errors).toBeUndefined();
        const second = await deleteRoster(s, role, actor, s.member);
        expect({ name, error: second.errors?.[0].message }).toEqual({
          name,
          error: expect.stringMatching(/below the minimum lineup/i),
        });
        expect(await rosterHas(s, s.member)).toBe(true);
      }
    });

    it("a player can still remove themselves, until the tournament is Live", async () => {
      const s = await scenario();
      await tournaments.setStatus(
        s.tournamentId,
        s.organizer,
        "RegistrationClosed",
      );
      const closed = await deleteRoster(
        s,
        "verified_user",
        s.substitute,
        s.substitute,
      );
      expect(closed.data.delete_tournament_team_roster.affected_rows).toBe(1);
    });
  });

  describe("tournament state locks are unchanged", () => {
    const goLive = async (s: Scenario) => {
      await tournaments.setStatus(
        s.tournamentId,
        s.organizer,
        "RegistrationClosed",
      );
      await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
      await postgres.query(
        "UPDATE tournaments SET status = 'Live' WHERE id = $1",
        [s.tournamentId],
      );
      await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
    };

    it("once Live, nobody on an ordinary session can remove, including the owner, team Admin and captain", async () => {
      const s = await scenario();
      await goLive(s);

      for (const name of [
        "Owner",
        "Team Admin",
        "Captain",
        "Tournament roster Admin",
      ]) {
        const [, actor, role] = actors(s).find(([n]) => n === name)!;
        const result = await deleteRoster(s, role, actor, s.substitute);
        expect({
          name,
          removed: result.data.delete_tournament_team_roster.affected_rows,
        }).toEqual({
          name,
          removed: 0,
        });
      }
      const self = await deleteRoster(
        s,
        "verified_user",
        s.substitute,
        s.substitute,
      );
      expect(self.data.delete_tournament_team_roster.affected_rows).toBe(0);
      expect(await rosterHas(s, s.substitute)).toBe(true);
    });

    it("once Live, an organizer-role session can still remove a surplus substitute, and the minimum guard still applies", async () => {
      const s = await scenario();
      await goLive(s);

      const surplus = await deleteRoster(
        s,
        "tournament_organizer",
        s.organizer,
        s.substitute,
      );
      expect(surplus.data.delete_tournament_team_roster.affected_rows).toBe(1);
      const starter = await deleteRoster(
        s,
        "tournament_organizer",
        s.organizer,
        s.member,
      );
      expect(starter.errors?.[0].message).toMatch(/below the minimum lineup/i);
    });

    it.each(["Finished", "Cancelled"])(
      "once %s, nobody can remove anyone",
      async (status) => {
        const s = await scenario();
        await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
        await postgres.query(
          "UPDATE tournaments SET status = $2 WHERE id = $1",
          [s.tournamentId, status],
        );
        await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");

        for (const name of [
          "Owner",
          "Team Admin",
          "Captain",
          "Tournament roster Admin",
          "Tournament organizer",
          "Site Admin",
        ]) {
          const [, actor, role] = actors(s).find(([n]) => n === name)!;
          const result = await deleteRoster(s, role, actor, s.substitute);
          expect({
            name,
            removed: result.data?.delete_tournament_team_roster.affected_rows,
          }).toEqual({
            name,
            removed: 0,
          });
        }
        expect(await rosterHas(s, s.substitute)).toBe(true);
      },
    );
  });

  describe("one player, one team", () => {
    it("removal permissions do not let a manager seat the same player on a second team", async () => {
      const s = await scenario();
      // A second registered team in the same tournament.
      const owner2 = await verified();
      const [team2] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("team"), owner2],
      );
      const tt2 = await tournaments.registerTeam(s.tournamentId, {
        id: team2.id,
        owner: owner2,
      });

      // The substitute is already on team 1's roster; team 2's owner cannot
      // take them too.
      const result = await gql(
        `mutation { insert_tournament_team_roster_one(object: {
           tournament_team_id: "${tt2}"
           player_steam_id: "${s.substitute}"
           tournament_id: "${s.tournamentId}"
         }) { player_steam_id } }`,
        "verified_user",
        owner2,
      );
      expect(result.errors?.[0].message).toMatch(
        /tournament_roster_pkey|duplicate key/i,
      );
    });
  });
});
