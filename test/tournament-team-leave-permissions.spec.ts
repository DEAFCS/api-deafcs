import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import {
  bootContainerAndMigrate,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Proves the narrowed tournament_teams delete_permissions (see
// public_tournament_teams.yaml): a normal participant/captain may leave a
// tournament team only in Setup/RegistrationOpen, while the tournament
// organizer keeps today's wider RegistrationClosed/Live/Paused removal
// window unchanged. Runs against a real Hasura container so the assertions
// reflect the actual GraphQL permission-denied shape (delete_..._by_pk
// returning null with no errors, because Hasura folds the permission filter
// into the DELETE's WHERE clause) rather than the underlying SQL trigger.
describe("tournament_teams delete permission narrowing", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  const ADMIN_SECRET = "team-leave-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TournamentTeamLeavePermissionTest");
    fx = new Fixtures(db.postgres, 76561199970000000n);
    tfx = new TournamentFixtures(db.postgres, fx);
    await seedRegionWithServer(db.postgres, "TestA");

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
    await db.postgres.query("DELETE FROM matches");
    await db.postgres.query("DELETE FROM tournaments");
    await db.postgres.query("DELETE FROM teams");
    await db.postgres.query("DELETE FROM player_terms_acceptances");
    await db.postgres.query("DELETE FROM players");
  });

  type DeleteResult = {
    data?: { delete_tournament_teams_by_pk: { id: string } | null };
    errors?: Array<{ message: string }>;
  };

  async function deleteTeam(
    tournamentTeamId: string,
    steamId: string,
    role = "user",
  ): Promise<DeleteResult> {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
        "x-hasura-role": role,
        "x-hasura-user-id": steamId,
      },
      body: JSON.stringify({
        query: `mutation LeaveTournament($id: uuid!) {
          delete_tournament_teams_by_pk(id: $id) { id }
        }`,
        variables: { id: tournamentTeamId },
      }),
    });
    return response.json() as Promise<DeleteResult>;
  }

  async function teamExists(id: string): Promise<boolean> {
    const rows = await db.postgres.query<Array<{ id: string }>>(
      "SELECT id FROM tournament_teams WHERE id = $1",
      [id],
    );
    return rows.length > 0;
  }

  // A denied-by-permission delete over Hasura is indistinguishable, on the
  // wire, from "row doesn't exist": the permission filter is folded into the
  // DELETE's own WHERE clause, so 0 rows match and _by_pk resolves to null
  // with no GraphQL errors at all. That is the opposite shape of a
  // downstream trigger failure (e.g. the match_lineup_players min-players
  // guard), which raises an actual GraphQL error and rolls back. Asserting
  // "no errors + null result + row survives" is what proves this outcome is
  // the permission layer denying the mutation, not an unrelated side effect.
  function expectPermissionDenied(result: DeleteResult) {
    expect(result.errors).toBeUndefined();
    expect(result.data?.delete_tournament_teams_by_pk).toBeNull();
  }

  function expectDeleted(result: DeleteResult, teamId: string) {
    expect(result.errors).toBeUndefined();
    expect(result.data?.delete_tournament_teams_by_pk?.id).toBe(teamId);
  }

  // Builds a 4-team single-elimination tournament through RegistrationClosed
  // (seed_stage materializes round-1 brackets/matches on the
  // RegistrationOpen -> RegistrationClosed transition, not on Live -- see
  // tau_tournaments), then advances to `finalStatus`. Every round-1 match is
  // force-set to 'Live' status before any delete is attempted: this takes the
  // match out of the Scheduled/WaitingForCheckIn/Canceled window that
  // refresh_tournament_match_lineup_teams acts on, so when the FK cascade
  // nulls a deleted team's bracket slot, that trigger short-circuits instead
  // of deleting match_lineup_players rows and tripping the unrelated
  // "Cannot remove players: not enough players in lineup" guard. Without
  // this, an organizer's legitimate RegistrationClosed/Live/Paused removal
  // (still allowed after this fix) could fail for that unrelated reason,
  // which would masquerade as -- but is not -- a permission result.
  async function buildLockedTournament(
    finalStatus: "RegistrationClosed" | "Live" | "Paused",
  ) {
    const tournament = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Wingman",
    );
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    const teams: Array<{ id: string; owner: string }> = [];
    for (let i = 0; i < 4; i++) {
      const team = await fx.team(1);
      const id = await tfx.registerTeam(tournament.id, team);
      teams.push({ id, owner: team.owner });
    }
    // tournament_match_is_pre_start() force-reverts any attempt to move a
    // round-1 match onto the playable ladder (including our own forced
    // status update below) for as long as the tournament's own `start` is
    // still in the future and status = RegistrationClosed -- see that
    // function's comment. createTournament() defaults start to +1 day, which
    // would silently no-op the force-to-Live update a few lines down; back
    // it into the past so the guard never applies, matching how a real
    // tournament's own kickoff time would clear it. Must happen after
    // RegistrationOpen: can_open_tournament_registration refuses to open
    // registration once start has already passed.
    await db.postgres.query(
      "UPDATE tournaments SET start = now() - interval '1 hour' WHERE id = $1",
      [tournament.id],
    );
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );

    const brackets = await tfx.getBrackets(tournament.stageIds[0]);
    for (const bracket of brackets) {
      if (bracket.match_id) {
        // A freshly-seeded tournament match sits at 'Scheduled' with no
        // match_maps row yet (map selection happens through veto, which
        // never ran here) -- forcing straight to 'Live' otherwise trips
        // tbu_matches' real "Match has no maps to play" guard.
        await db.postgres.query(
          `INSERT INTO match_maps (match_id, map_id, "order")
           SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
          [bracket.match_id],
        );
        await db.postgres.query(
          "UPDATE matches SET status = 'Live' WHERE id = $1",
          [bracket.match_id],
        );
      }
    }

    if (finalStatus === "Live" || finalStatus === "Paused") {
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");
    }
    if (finalStatus === "Paused") {
      await tfx.setStatus(tournament.id, tournament.organizer, "Paused");
    }

    return { tournament, teams };
  }

  describe.each([["RegistrationClosed"], ["Live"], ["Paused"]] as const)(
    "status %s",
    (status) => {
      it(`normal captain is denied by permission (not the lineup trigger)`, async () => {
        const { tournament, teams } = await buildLockedTournament(status);
        const target = teams[0];

        const result = await deleteTeam(target.id, target.owner);

        expectPermissionDenied(result);
        expect(await teamExists(target.id)).toBe(true);
      });

      it(`organizer may still remove a team`, async () => {
        const { tournament, teams } = await buildLockedTournament(status);
        const target = teams[1];

        const result = await deleteTeam(target.id, tournament.organizer);

        expectDeleted(result, target.id);
        expect(await teamExists(target.id)).toBe(false);
      });
    },
  );

  describe("terminal statuses", () => {
    async function buildCancelledTournament() {
      const tournament = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        4,
        "Wingman",
      );
      const teams = await db.postgres.query<Array<{ id: string; owner_steam_id: string }>>(
        "SELECT id, owner_steam_id FROM tournament_teams WHERE tournament_id = $1 ORDER BY created_at",
        [tournament.id],
      );
      await tfx.setStatus(tournament.id, tournament.organizer, "Cancelled");
      return { tournament, teams };
    }

    async function buildCancelledMinTeamsTournament() {
      const tournament = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(
        tournament.id,
        tournament.organizer,
        "RegistrationOpen",
      );
      const teams: Array<{ id: string; owner: string }> = [];
      // Fewer than the stage's minTeams (4): requesting Live below redirects
      // to CancelledMinTeams instead (tbu_tournaments' Live case).
      for (let i = 0; i < 2; i++) {
        const team = await fx.team(1);
        const id = await tfx.registerTeam(tournament.id, team);
        teams.push({ id, owner: team.owner });
      }
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");
      return { tournament, teams };
    }

    async function buildFinishedTournament() {
      const tournament = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        4,
        "Wingman",
      );
      // Calculated awards for a Finished tournament aren't relevant to this
      // permission test and their award_occurrences rows make the next
      // test's beforeEach cleanup (a plain DELETE FROM tournaments) trip
      // award_occurrences_calculated_tournament -- see
      // tournament-deletion.spec.ts's dedicated transaction-based deletion
      // helper for that real, unrelated constraint. Simplest fix here: never
      // generate any award occurrences for this tournament at all.
      await db.postgres.query(
        "UPDATE tournaments SET awards_enabled = false, trophies_enabled = false WHERE id = $1",
        [tournament.id],
      );
      const teamsBefore = await db.postgres.query<Array<{ id: string; owner_steam_id: string }>>(
        "SELECT id, owner_steam_id FROM tournament_teams WHERE tournament_id = $1 ORDER BY created_at",
        [tournament.id],
      );
      await tfx.playRound(tournament.stageIds[0], 1);
      await tfx.playRound(tournament.stageIds[0], 2);
      expect(await tfx.tournamentStatus(tournament.id)).toBe("Finished");
      return { tournament, teams: teamsBefore };
    }

    it("Cancelled: both normal captain and organizer are denied", async () => {
      const { tournament, teams } = await buildCancelledTournament();
      expect(await tfx.tournamentStatus(tournament.id)).toBe("Cancelled");

      const userResult = await deleteTeam(teams[0].id, teams[0].owner_steam_id);
      expectPermissionDenied(userResult);
      expect(await teamExists(teams[0].id)).toBe(true);

      const organizerResult = await deleteTeam(teams[1].id, tournament.organizer);
      expectPermissionDenied(organizerResult);
      expect(await teamExists(teams[1].id)).toBe(true);
    });

    it("CancelledMinTeams: both normal captain and organizer are denied", async () => {
      const { tournament, teams } = await buildCancelledMinTeamsTournament();
      expect(await tfx.tournamentStatus(tournament.id)).toBe("CancelledMinTeams");

      const userResult = await deleteTeam(teams[0].id, teams[0].owner);
      expectPermissionDenied(userResult);
      expect(await teamExists(teams[0].id)).toBe(true);

      const organizerResult = await deleteTeam(teams[1].id, tournament.organizer);
      expectPermissionDenied(organizerResult);
      expect(await teamExists(teams[1].id)).toBe(true);
    });

    it("Finished: both normal captain and organizer are denied", async () => {
      const { tournament, teams } = await buildFinishedTournament();

      const userResult = await deleteTeam(teams[0].id, teams[0].owner_steam_id);
      expectPermissionDenied(userResult);
      expect(await teamExists(teams[0].id)).toBe(true);

      const organizerResult = await deleteTeam(teams[1].id, tournament.organizer);
      expectPermissionDenied(organizerResult);
      expect(await teamExists(teams[1].id)).toBe(true);
    });
  });

  describe("Setup and RegistrationOpen remain open to the normal captain", () => {
    it("Setup: a free-agent/team captain may leave", async () => {
      const tournament = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      const team = await fx.team(1);
      const teamId = await tfx.registerTeam(tournament.id, team);

      const result = await deleteTeam(teamId, team.owner);

      expectDeleted(result, teamId);
      expect(await teamExists(teamId)).toBe(false);
    });

    it("RegistrationOpen: the captain may leave", async () => {
      const tournament = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(
        tournament.id,
        tournament.organizer,
        "RegistrationOpen",
      );
      const team = await fx.team(1);
      const teamId = await tfx.registerTeam(tournament.id, team);

      const result = await deleteTeam(teamId, team.owner);

      expectDeleted(result, teamId);
      expect(await teamExists(teamId)).toBe(false);
    });
  });
});
