import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Exercises the actual Hasura-enforced insert permissions for tournament
// registration (team + individual) against a real Hasura instance bound to
// the repo's hasura/metadata, the same pattern as
// awards-metadata.spec.ts / tournament-guest-visibility.spec.ts. Raw SQL
// (as in permissions.spec.ts / tournament-min-role.spec.ts) bypasses
// Hasura's declarative check expressions entirely -- there is no Postgres
// RLS backing them -- so this is the only way to verify enforcement.
describe("tournaments.min_role registration enforcement (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "min-role-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TournamentMinRoleMetadataTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199962000000n);
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

  const setPlayerRole = (steamId: string, role: string) =>
    postgres.query("UPDATE players SET role = $1 WHERE steam_id = $2", [
      role,
      steamId,
    ]);

  // Registers a permanent-team-linked tournament_teams row. Shared across
  // the insert and update describes below: a free-agent (team_id null)
  // tournament_teams row routes non-owner roster adds through an invite
  // instead of a direct insert (see tbi_tournament_team_roster in
  // hasura/triggers/tournament_team_roster.sql), so these use a linked
  // registration -- the path a real owner adding teammates actually takes
  // -- to exercise the roster insert/update checks directly rather than
  // that unrelated invite redirect.
  //
  // tai_tournament_team (hasura/triggers/tournament_teams.sql) auto-fills
  // tournament_team_roster from the linked team's own team_roster right
  // after this insert (deferred to commit), which now goes through the
  // same target_meets_min_role gate as everything else -- so the owner's
  // *real* stored role has to clear the tournament's minimum before
  // registration will even succeed, independent of the session role used
  // to make this call. ownerRole sets that; defaults to "verified_user"
  // since every caller here targets a verified_user-minimum tournament
  // except the unrestricted (min_role null) case, where it's irrelevant.
  const registerLinkedTeam = (
    tournamentId: string,
    teamId: string,
    owner: string,
    sessionRole: string,
    ownerRole = "verified_user",
  ) =>
    setPlayerRole(owner, ownerRole).then(() =>
      gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${tournamentId}"
            team_id: "${teamId}"
            name: "Linked Team"
            short_name: "LT"
          }) { id }
        }`,
        sessionRole,
        owner,
      ),
    );

  const openTournament = async (minRole: string | null) => {
    // can_open_tournament_registration() requires at least one stage.
    const t = await tournaments.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
    ]);
    await postgres.query("UPDATE tournaments SET min_role = $2 WHERE id = $1", [
      t.id,
      minRole,
    ]);
    await postgres.query(
      `UPDATE match_options SET individual_registration_enabled = true
       WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    // Goes through the tbu_tournaments trigger with a real admin session,
    // same as TournamentFixtures.launch() elsewhere in the suite.
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
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

  describe("team registration", () => {
    it("denies a free-agent team below the minimum role", async () => {
      const t = await openTournament("verified_user");
      const owner = await fx.player();
      await setPlayerRole(owner, "user");

      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "Below Min"
            short_name: "BM"
          }) { id }
        }`,
        "user",
        owner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_teams_one ?? null).toBeNull();
    });

    it("allows a free-agent team at or above the minimum role", async () => {
      const t = await openTournament("verified_user");
      const owner = await fx.player();
      await setPlayerRole(owner, "verified_user");

      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "At Min"
            short_name: "AM"
          }) { id }
        }`,
        "verified_user",
        owner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_teams_one?.id).toBeDefined();
    });

    it("still lets the tournament organizer register a team regardless of min_role", async () => {
      const t = await openTournament("administrator");

      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "Organizer Entry"
            short_name: "OE"
          }) { id }
        }`,
        "user",
        t.organizer,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_teams_one?.id).toBeDefined();
    });

    it("unrestricted (min_role null) allows any real role", async () => {
      const t = await openTournament(null);
      const owner = await fx.player();
      await setPlayerRole(owner, "user");

      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "Unrestricted"
            short_name: "UR"
          }) { id }
        }`,
        "user",
        owner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_teams_one?.id).toBeDefined();
    });
  });

  describe("tournament_team_roster insert (adding a player to a registered team)", () => {
    it("denies below the minimum role", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      const mate = await fx.player();

      // Same owner (still passes the team-ownership check), but this
      // particular request's session role is below the tournament's
      // minimum -- meets_min_role must still deny it.
      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "${mate}"
          }) { player_steam_id }
        }`,
        "user",
        team.owner,
      );
      expect(result.data?.insert_tournament_team_roster_one ?? null).toBeNull();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, mate],
      );
      expect((rows as unknown[]).length).toBe(0);
    });

    it("allows at or above the minimum role", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      const mate = await fx.player();
      // The target player's own stored role must also clear the minimum,
      // independent of the acting session's role.
      await setPlayerRole(mate, "verified_user");

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "${mate}"
          }) { player_steam_id }
        }`,
        "verified_user",
        team.owner,
      );
      // player_steam_id round-trips through the GraphQL response as a bare
      // JSON number, which loses precision past Number.MAX_SAFE_INTEGER for
      // a real 17-digit steam id -- verify against Postgres (returns bigint
      // columns as exact strings) instead of the JSON-parsed response value.
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_team_roster_one).toBeTruthy();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, mate],
      );
      expect((rows as unknown[]).length).toBe(1);
    });

    // CASE B from the bug report: an eligible captain of a linked
    // (permanent-team-backed) tournament_teams row must not be able to put
    // an ineligible teammate onto the roster just because the captain
    // themself clears meets_min_role and owns the team. Regression test for
    // the hole target_meets_min_role closes.
    it("denies an ineligible target even when the acting captain is fully eligible and authorized", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      const mate = await fx.player(); // defaults to role 'user'

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "${mate}"
          }) { player_steam_id }
        }`,
        "verified_user",
        team.owner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_team_roster_one ?? null).toBeNull();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, mate],
      );
      expect((rows as unknown[]).length).toBe(0);
    });

    it("missing target player fails closed", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "76561199999999999"
          }) { player_steam_id }
        }`,
        "verified_user",
        team.owner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_team_roster_one ?? null).toBeNull();
    });

    it("unrestricted (min_role null) allows a normal user target", async () => {
      const t = await openTournament(null);
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      const mate = await fx.player(); // defaults to role 'user'

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "${mate}"
          }) { player_steam_id }
        }`,
        "user",
        team.owner,
      );
      expect(result.errors).toBeUndefined();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, mate],
      );
      expect((rows as unknown[]).length).toBe(1);
    });

    describe("tournament_organizer role", () => {
      it("denies an organizer adding an ineligible target -- no broad organizer bypass remains", async () => {
        const t = await openTournament("verified_user");
        const team = await fx.team(0);
        const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
        const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
        const mate = await fx.player(); // defaults to role 'user'

        const result = await gql(
          `mutation {
            insert_tournament_team_roster_one(object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${mate}"
            }) { player_steam_id }
          }`,
          "tournament_organizer",
          t.organizer,
        );
        expect(result.errors).toBeDefined();
        expect(result.data?.insert_tournament_team_roster_one ?? null).toBeNull();
        const rows = await postgres.query(
          "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
          [tournamentTeamId, mate],
        );
        expect((rows as unknown[]).length).toBe(0);
      });

      it("allows an organizer adding an eligible target", async () => {
        const t = await openTournament("verified_user");
        const team = await fx.team(0);
        const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
        const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
        const mate = await fx.player();
        await setPlayerRole(mate, "verified_user");

        const result = await gql(
          `mutation {
            insert_tournament_team_roster_one(object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${mate}"
            }) { player_steam_id }
          }`,
          "tournament_organizer",
          t.organizer,
        );
        expect(result.errors).toBeUndefined();
        const rows = await postgres.query(
          "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
          [tournamentTeamId, mate],
        );
        expect((rows as unknown[]).length).toBe(1);
      });
    });
  });

  describe("tournament_team_roster update", () => {
    // Seeds a roster row directly (bypassing Hasura AND the
    // tbi_tournament_team_roster trigger's own INSERT-time eligibility
    // check) the way an already-existing/legacy row -- seated before this
    // fix shipped -- would sit in the database, so the UPDATE check can be
    // exercised on its own rather than proving the (already-covered)
    // INSERT check instead.
    const seedRosterRow = async (tournamentTeamId: string, tournamentId: string, steamId: string) => {
      await postgres.query(
        "ALTER TABLE tournament_team_roster DISABLE TRIGGER tbi_tournament_team_roster",
      );
      try {
        await postgres.query(
          `INSERT INTO tournament_team_roster (tournament_team_id, tournament_id, player_steam_id, role)
           VALUES ($1, $2, $3, 'Member')`,
          [tournamentTeamId, tournamentId, steamId],
        );
      } finally {
        await postgres.query(
          "ALTER TABLE tournament_team_roster ENABLE TRIGGER tbi_tournament_team_roster",
        );
      }
    };

    // registerLinkedTeam's auto-fill (tai_tournament_team) seats the owner
    // as a plain 'Member', not 'Admin' -- the update permission's
    // authorization only allows an existing tournament-roster Admin (or the
    // organizer) to change a role, so give the owner that standing directly
    // (a raw role UPDATE, not an insert, so it doesn't touch the INSERT-time
    // eligibility check at all).
    const promoteToAdmin = (tournamentTeamId: string, steamId: string) =>
      postgres.query(
        "UPDATE tournament_team_roster SET role = 'Admin' WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, steamId],
      );

    it("denies a role update on an existing roster row whose target player is ineligible -- no reassignment/update loophole", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      await promoteToAdmin(tournamentTeamId, team.owner);
      const mate = await fx.player(); // defaults to role 'user', below the minimum
      await seedRosterRow(tournamentTeamId, t.id, mate);

      const result = await gql(
        `mutation {
          update_tournament_team_roster(
            where: { tournament_team_id: { _eq: "${tournamentTeamId}" }, player_steam_id: { _eq: "${mate}" } }
            _set: { role: Admin }
          ) { affected_rows }
        }`,
        "verified_user",
        team.owner,
      );
      expect(result.data?.update_tournament_team_roster?.affected_rows ?? 0).toBe(0);
      const rows = await postgres.query<Array<{ role: string }>>(
        "SELECT role FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, mate],
      );
      expect((rows as Array<{ role: string }>)[0]?.role).toBe("Member");
    });

    it("allows a role update on an existing roster row whose target player is eligible", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      await promoteToAdmin(tournamentTeamId, team.owner);
      const mate = await fx.player();
      await setPlayerRole(mate, "verified_user");
      await seedRosterRow(tournamentTeamId, t.id, mate);

      const result = await gql(
        `mutation {
          update_tournament_team_roster(
            where: { tournament_team_id: { _eq: "${tournamentTeamId}" }, player_steam_id: { _eq: "${mate}" } }
            _set: { role: Admin }
          ) { affected_rows }
        }`,
        "verified_user",
        team.owner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.update_tournament_team_roster?.affected_rows).toBe(1);
    });

    it("denies a tournament_organizer role update on an existing roster row whose target player is ineligible", async () => {
      const t = await openTournament("verified_user");
      const team = await fx.team(0);
      const entry = await registerLinkedTeam(t.id, team.id, team.owner, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;
      const mate = await fx.player(); // defaults to role 'user'
      await seedRosterRow(tournamentTeamId, t.id, mate);

      const result = await gql(
        `mutation {
          update_tournament_team_roster(
            where: { tournament_team_id: { _eq: "${tournamentTeamId}" }, player_steam_id: { _eq: "${mate}" } }
            _set: { role: Admin }
          ) { affected_rows }
        }`,
        "tournament_organizer",
        t.organizer,
      );
      expect(result.data?.update_tournament_team_roster?.affected_rows ?? 0).toBe(0);
    });
  });

  // CASE A from the bug report: a tournament-only (free-agent) team's
  // captain invites a below-minimum player; accepting that invite must not
  // be able to seat them on the roster. invites.controller.ts now issues
  // the same insert_tournament_team_roster_one mutation under the
  // *accepting player's own session* instead of the admin secret, so this
  // exercises the exact permission path acceptance now goes through --
  // the invite row itself is seeded directly since the normal captain ->
  // invite path is independently blocked before it ever creates one (see
  // "captain cannot invite an ineligible player" below).
  describe("tournament team invite acceptance (self-insert)", () => {
    const createFreeAgentTeam = (tournamentId: string, captain: string, captainRole: string) =>
      gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${tournamentId}"
            name: "Free Agents"
            short_name: "FA"
            roster: { data: [{ tournament_id: "${tournamentId}", player_steam_id: "${captain}" }] }
          }) { id }
        }`,
        captainRole,
        captain,
      );

    const seedInvite = (tournamentTeamId: string, steamId: string, invitedBy: string) =>
      postgres.query(
        `INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, steamId, invitedBy],
      );

    it("denies acceptance for a below-minimum invited player -- the invite-acceptance bypass is fixed", async () => {
      const t = await openTournament("verified_user");
      const captain = await fx.player();
      await setPlayerRole(captain, "verified_user");
      const entry = await createFreeAgentTeam(t.id, captain, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const invitee = await fx.player(); // defaults to role 'user'
      await seedInvite(tournamentTeamId, invitee, captain);

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(
            object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${invitee}"
            }
            on_conflict: { constraint: tournament_roster_pkey, update_columns: [role] }
          ) { player_steam_id }
        }`,
        "user",
        invitee,
      );
      expect(result.errors).toBeDefined();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, invitee],
      );
      expect((rows as unknown[]).length).toBe(0);
    });

    it("allows acceptance for an eligible invited player", async () => {
      const t = await openTournament("verified_user");
      const captain = await fx.player();
      await setPlayerRole(captain, "verified_user");
      const entry = await createFreeAgentTeam(t.id, captain, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const invitee = await fx.player();
      await setPlayerRole(invitee, "verified_user");
      await seedInvite(tournamentTeamId, invitee, captain);

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(
            object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${invitee}"
            }
            on_conflict: { constraint: tournament_roster_pkey, update_columns: [role] }
          ) { player_steam_id }
        }`,
        "verified_user",
        invitee,
      );
      expect(result.errors).toBeUndefined();
      const rows = await postgres.query(
        "SELECT 1 FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, invitee],
      );
      expect((rows as unknown[]).length).toBe(1);
    });

    it("captain cannot invite (redirect-insert) an ineligible player onto a free-agent team in the first place", async () => {
      const t = await openTournament("verified_user");
      const captain = await fx.player();
      await setPlayerRole(captain, "verified_user");
      const entry = await createFreeAgentTeam(t.id, captain, "verified_user");
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const target = await fx.player(); // defaults to role 'user'
      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(object: {
            tournament_id: "${t.id}"
            tournament_team_id: "${tournamentTeamId}"
            player_steam_id: "${target}"
          }) { player_steam_id }
        }`,
        "verified_user",
        captain,
      );
      expect(result.errors).toBeDefined();
      const invites = await postgres.query(
        "SELECT 1 FROM tournament_team_invites WHERE tournament_team_id = $1 AND steam_id = $2",
        [tournamentTeamId, target],
      );
      expect((invites as unknown[]).length).toBe(0);
    });
  });

  describe("individual registration", () => {
    it("denies below the minimum role", async () => {
      const t = await openTournament("verified_user");
      const player = await fx.player();
      await setPlayerRole(player, "user");

      const result = await gql(
        `mutation {
          insert_tournament_individual_signups_one(object: {
            tournament_id: "${t.id}"
            player_steam_id: "${player}"
          }) { id }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_individual_signups_one ?? null).toBeNull();
    });

    it("allows at or above the minimum role", async () => {
      const t = await openTournament("verified_user");
      const player = await fx.player();

      const result = await gql(
        `mutation {
          insert_tournament_individual_signups_one(object: {
            tournament_id: "${t.id}"
            player_steam_id: "${player}"
          }) { id }
        }`,
        "verified_user",
        player,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_individual_signups_one?.id).toBeDefined();
    });
  });

  describe("guest", () => {
    it("can still read a tournament's min_role and individual_signups", async () => {
      const t = await openTournament("verified_user");
      const result = await gql(
        `query {
          tournaments_by_pk(id: "${t.id}") {
            id
            min_role
            individual_signups { id }
          }
        }`,
        "guest",
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.tournaments_by_pk?.min_role).toBe("verified_user");
    });

    it("cannot insert a team, roster entry, or individual signup", async () => {
      const t = await openTournament("verified_user");

      for (const mutation of [
        `mutation { insert_tournament_teams_one(object: { tournament_id: "${t.id}", name: "G", short_name: "G" }) { id } }`,
        `mutation { insert_tournament_individual_signups_one(object: { tournament_id: "${t.id}", player_steam_id: "1" }) { id } }`,
        `mutation { insert_tournament_team_roster_one(object: { tournament_id: "${t.id}", tournament_team_id: "00000000-0000-0000-0000-000000000000", player_steam_id: "1" }) { player_steam_id } }`,
      ]) {
        const result = await gql(mutation, "guest");
        expect(result.errors).toBeDefined();
      }
    });
  });
});
