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

// Team managers (owner, team Admin, captain) can enter several of their teams
// in one tournament; a plain Member or an Invite cannot enter any. Runs the
// real Hasura insert permission against the repo metadata (raw SQL bypasses
// it), plus the triggers/constraints behind it:
//   * one entry per team per tournament   tournament_teams_tournament_id_team_id_key
//   * one roster spot per player          tournament_roster_pkey
//   * owner follows team ownership        tau_teams_owner_sync
describe("tournament registration by team managers (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "manager-registration-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TournamentManagerRegistrationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
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

  const gql = async (
    query: string,
    steamId: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
        "x-hasura-role": "verified_user",
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };

  const verified = async (): Promise<string> => {
    const steam = await fx.player();
    await postgres.query(
      "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
      [steam],
    );
    return steam;
  };

  // A team whose owner is verified, with an optional roster of extra members.
  const makeTeam = async (mates = 0) => {
    const owner = await verified();
    const [team] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("team"), owner],
    );
    const members: Array<string> = [];
    for (let i = 0; i < mates; i++) {
      const mate = await verified();
      await addToTeam(team.id, owner, mate, "Member");
      members.push(mate);
    }
    return { id: team.id, owner, members };
  };

  // tbi_team_roster forces every inserted row to Member, so a non-Member role
  // is set the way production does it: a role change after joining.
  const addToTeam = (
    teamId: string,
    byOwner: string,
    steam: string,
    role: "Admin" | "Member" | "Invite",
  ) =>
    runAsUser(postgres, byOwner, "admin", async (query) => {
      await query(
        "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
        [teamId, steam],
      );
      if (role !== "Member") {
        await query(
          "UPDATE team_roster SET role = $3 WHERE team_id = $1 AND player_steam_id = $2",
          [teamId, steam, role],
        );
      }
    });

  const setCaptain = (teamId: string, byOwner: string, steam: string) =>
    runAsUser(postgres, byOwner, "admin", (query) =>
      query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        teamId,
        steam,
      ]),
    );

  const openTournament = async () => {
    const t = await tournaments.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ]);
    await postgres.query(
      "UPDATE tournaments SET min_role = NULL WHERE id = $1",
      [t.id],
    );
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  };

  const register = (
    tournamentId: string,
    teamId: string,
    as: string,
    roster?: Array<string>,
  ) =>
    gql(
      `mutation {
        insert_tournament_teams_one(object: {
          tournament_id: "${tournamentId}"
          team_id: "${teamId}"
          ${
            roster
              ? `roster: { data: [${roster
                  .map(
                    (s) =>
                      `{ player_steam_id: "${s}", tournament_id: "${tournamentId}" }`,
                  )
                  .join(",")}] }`
              : ""
          }
        }) { id owner_steam_id captain_steam_id }
      }`,
      as,
    );

  const entries = (tournamentId: string) =>
    postgres.query<
      Array<{
        id: string;
        team_id: string | null;
        owner_steam_id: string;
        captain_steam_id: string;
      }>
    >(
      `SELECT id, team_id, owner_steam_id::text, captain_steam_id::text
         FROM tournament_teams WHERE tournament_id = $1`,
      [tournamentId],
    );

  it("has zero inconsistent metadata objects", async () => {
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

  describe("who may register a team", () => {
    it("A: the team owner can", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);
      const result = await register(t.id, team.id, team.owner);
      expect(result.errors).toBeUndefined();
      expect((await entries(t.id))[0].owner_steam_id).toBe(team.owner);
    });

    it("B: a team Admin who is not the owner can, and the owner of record stays the team owner", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);
      const admin = await verified();
      await addToTeam(team.id, team.owner, admin, "Admin");

      const result = await register(t.id, team.id, admin);
      expect(result.errors).toBeUndefined();
      expect((await entries(t.id))[0].owner_steam_id).toBe(team.owner);
    });

    it("C: the team captain can", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);
      const captain = team.members[0];
      await setCaptain(team.id, team.owner, captain);

      const result = await register(t.id, team.id, captain);
      expect(result.errors).toBeUndefined();
      expect(result.data.insert_tournament_teams_one.id).toBeDefined();
    });

    it("D: a plain Member cannot", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);

      const result = await register(t.id, team.id, team.members[0]);
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_teams_one ?? null).toBeNull();
      expect(await entries(t.id)).toHaveLength(0);
    });

    it("E: an Invite cannot", async () => {
      const t = await openTournament();
      const team = await makeTeam(0);
      const invited = await verified();
      await addToTeam(team.id, team.owner, invited, "Invite");

      const result = await register(t.id, team.id, invited);
      expect(result.errors).toBeDefined();
      expect(await entries(t.id)).toHaveLength(0);
    });
  });

  describe("one manager, several teams", () => {
    it("F: the same Admin can register two different teams in one tournament", async () => {
      const t = await openTournament();
      const admin = await verified();
      const teamA = await makeTeam(1);
      const teamB = await makeTeam(1);
      await addToTeam(teamA.id, teamA.owner, admin, "Admin");
      await addToTeam(teamB.id, teamB.owner, admin, "Admin");

      expect((await register(t.id, teamA.id, admin)).errors).toBeUndefined();
      expect((await register(t.id, teamB.id, admin)).errors).toBeUndefined();
      expect(await entries(t.id)).toHaveLength(2);
    });

    it("G: the same owner can register two different teams in one tournament", async () => {
      const t = await openTournament();
      const owner = await verified();
      const [teamA] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("main"), owner],
      );
      const [teamB] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("academy"), owner],
      );
      const mate = await verified();
      await addToTeam(teamB.id, owner, mate, "Member");

      // Distinct rosters: the owner only plays for one of them.
      expect(
        (await register(t.id, teamA.id, owner, [owner])).errors,
      ).toBeUndefined();
      expect(
        (await register(t.id, teamB.id, owner, [mate])).errors,
      ).toBeUndefined();

      const rows = await entries(t.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.owner_steam_id === owner)).toBe(true);
    });

    it("J: a manager who is on neither playing roster can still register both teams", async () => {
      const t = await openTournament();
      const manager = await verified();
      const teamA = await makeTeam(1);
      const teamB = await makeTeam(1);
      await addToTeam(teamA.id, teamA.owner, manager, "Admin");
      await addToTeam(teamB.id, teamB.owner, manager, "Admin");

      expect(
        (await register(t.id, teamA.id, manager, [teamA.members[0]])).errors,
      ).toBeUndefined();
      expect(
        (await register(t.id, teamB.id, manager, [teamB.members[0]])).errors,
      ).toBeUndefined();

      const onRoster = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, manager],
      );
      expect(onRoster).toHaveLength(0);
      expect(await entries(t.id)).toHaveLength(2);
    });
  });

  describe("uniqueness", () => {
    it("H: the same team cannot be registered twice in one tournament", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);
      expect(
        (await register(t.id, team.id, team.owner)).errors,
      ).toBeUndefined();

      const again = await register(t.id, team.id, team.owner);
      expect(again.errors?.[0].message).toMatch(
        /tournament_teams_tournament_id_team_id_key/,
      );
      expect(await entries(t.id)).toHaveLength(1);
    });

    it("I: a player cannot be on two teams' rosters in one tournament", async () => {
      const t = await openTournament();
      const teamA = await makeTeam(1);
      const teamB = await makeTeam(1);
      const shared = teamA.members[0];
      await addToTeam(teamB.id, teamB.owner, shared, "Member");

      expect(
        (await register(t.id, teamA.id, teamA.owner, [shared])).errors,
      ).toBeUndefined();

      const second = await register(t.id, teamB.id, teamB.owner, [shared]);
      expect(second.errors?.[0].message).toMatch(/tournament_roster_pkey/);
      expect(await entries(t.id)).toHaveLength(1);
    });

    it("keeps the owner constraint off registered teams but on tournament-only teams", async () => {
      const legacy = await postgres.query<Array<unknown>>(
        `SELECT 1 FROM pg_constraint
          WHERE conname = 'tournament_teams_creator_steam_id_tournament_id_key'`,
      );
      expect(legacy).toHaveLength(0);

      const t = await openTournament();
      const owner = await verified();
      const own = (name: string) =>
        gql(
          `mutation { insert_tournament_teams_one(object: {
             tournament_id: "${t.id}" name: "${name}" short_name: "T"
           }) { id } }`,
          owner,
        );
      expect((await own("Only One")).errors).toBeUndefined();
      expect((await own("Only Two")).errors?.[0].message).toMatch(
        /tournament_teams_owner_tournament_only_key/,
      );
    });
  });

  describe("ownership transfer after registration", () => {
    const transferOwner = (teamId: string, from: string, to: string) =>
      runAsUser(postgres, from, "admin", (query) =>
        query("UPDATE teams SET owner_steam_id = $2 WHERE id = $1", [
          teamId,
          to,
        ]),
      );

    it("K: the entry follows the new owner, and the former owner can register another team (the CSSR case)", async () => {
      const t = await openTournament();
      const former = await verified();
      const successor = await verified();
      const [main] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("main"), former],
      );
      const [academy] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("academy"), former],
      );
      await addToTeam(main.id, former, successor, "Admin");
      const academyMate = await verified();
      await addToTeam(academy.id, former, academyMate, "Member");

      expect(
        (await register(t.id, main.id, former, [successor])).errors,
      ).toBeUndefined();
      await transferOwner(main.id, former, successor);

      const [mainEntry] = await postgres.query<Array<{ owner: string }>>(
        "SELECT owner_steam_id::text AS owner FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2",
        [t.id, main.id],
      );
      expect(mainEntry.owner).toBe(successor);

      const academyResult = await register(t.id, academy.id, former, [
        academyMate,
      ]);
      expect(academyResult.errors).toBeUndefined();
    });

    it("L: changing the owner or admins does not change the tournament captain", async () => {
      const t = await openTournament();
      const team = await makeTeam(2);
      const [captain, successor] = team.members;
      await setCaptain(team.id, team.owner, captain);
      await addToTeam(team.id, team.owner, await verified(), "Admin");
      expect(
        (await register(t.id, team.id, team.owner)).errors,
      ).toBeUndefined();

      const [before] = await entries(t.id);
      expect(before.captain_steam_id).toBe(captain);

      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, successor],
        ),
      );
      await transferOwner(team.id, team.owner, successor);

      const [after] = await entries(t.id);
      expect(after.owner_steam_id).toBe(successor);
      expect(after.captain_steam_id).toBe(captain);
    });

    it("keeps the owner of record in a finished tournament", async () => {
      const t = await openTournament();
      const team = await makeTeam(1);
      const successor = team.members[0];
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, successor],
        ),
      );
      expect(
        (await register(t.id, team.id, team.owner)).errors,
      ).toBeUndefined();

      await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
      await postgres.query(
        "UPDATE tournaments SET status = 'Finished' WHERE id = $1",
        [t.id],
      );
      await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query("UPDATE teams SET owner_steam_id = $2 WHERE id = $1", [
          team.id,
          successor,
        ]),
      );

      const [entry] = await entries(t.id);
      expect(entry.owner_steam_id).toBe(team.owner);
    });
  });
});
