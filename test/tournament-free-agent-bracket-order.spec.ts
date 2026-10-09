import { TournamentRegistrationService } from "../src/tournaments/tournament-registration.service";
import { TournamentRegistrationController } from "../src/tournaments/tournament-registration.controller";
import { ProcessTournamentCheckIn } from "../src/matches/jobs/ProcessTournamentCheckIn";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, SqlTestDb, seedRegionWithServer } from "./utils/sql-test-db";

// Free Agents must be drafted into teams BEFORE the bracket is drawn, whichever
// way registration closes. A team that is created after the bracket exists is
// seeded past the last slot: it is in the tournament and nowhere in the bracket.
describe("free agent draft happens before the bracket (DEAFCS)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("FreeAgentBracketOrder");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199969500000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600000);
  afterAll(async () => {
    await db?.stop();
  });

  function user(steam_id: string, role = "user") {
    return { steam_id, role, name: "Fixture" } as any;
  }

  function registration() {
    return new TournamentRegistrationController(
      { log: jest.fn() } as any,
      postgres,
      { notifyPlayers: jest.fn() } as any,
      { getConnection: () => ({ eval: jest.fn().mockResolvedValue(1) }) } as any,
      { assertAccepted: jest.fn() } as any,
      new TournamentRegistrationService(postgres),
    );
  }

  async function cup(registrationType = "both", maxTeams = 4) {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams }],
      "Wingman",
      2,
    );
    await postgres.query(
      "UPDATE tournaments SET registration_type = $2 WHERE id = $1",
      [t.id, registrationType],
    );
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  }

  async function signup(tournamentId: string, count: number) {
    for (const p of await fx.players(count)) {
      await postgres.query(
        "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
        [tournamentId, p],
      );
    }
  }

  async function teams(tournamentId: string) {
    return postgres.query<
      Array<{ id: string; is_drafted: boolean; seed: number | null; eligible: boolean }>
    >(
      `SELECT id, is_drafted, seed, eligible_at IS NOT NULL AS eligible
         FROM tournament_teams WHERE tournament_id = $1`,
      [tournamentId],
    );
  }

  // Every team slot of the first round, flattened.
  async function bracketTeams(tournamentId: string) {
    const rows = await postgres.query<
      Array<{ tournament_team_id_1: string | null; tournament_team_id_2: string | null }>
    >(
      `SELECT tb.tournament_team_id_1, tb.tournament_team_id_2
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1 AND tb.round = 1`,
      [tournamentId],
    );
    return rows
      .flatMap((r) => [r.tournament_team_id_1, r.tournament_team_id_2])
      .filter((id): id is string => id !== null);
  }

  async function expectEveryTeamInBracket(tournamentId: string, expected: number) {
    const all = await teams(tournamentId);
    expect(all).toHaveLength(expected);
    expect(all.every((t) => t.eligible && t.seed !== null)).toBe(true);
    const inBracket = await bracketTeams(tournamentId);
    expect(inBracket).toHaveLength(expected);
    expect(new Set(inBracket).size).toBe(expected);
    expect([...inBracket].sort()).toEqual(all.map((t) => t.id).sort());
  }

  async function openWindow(id: string) {
    await postgres.query(
      "UPDATE tournaments SET check_in_required = true, check_in_setting = 'Captains', start = now() + interval '30 minutes' WHERE id = $1",
      [id],
    );
    await postgres.query(
      "UPDATE tournaments SET check_in_ends_at = now() + interval '15 minutes' WHERE id = $1",
      [id],
    );
  }

  async function runCheckInJob() {
    const job = new ProcessTournamentCheckIn(
      { log: jest.fn() } as any,
      postgres,
      { notifyPlayers: jest.fn() } as any,
    );
    await job.process();
  }

  it("check-in OFF: 2 premade + 2 drafted teams are all in the bracket when registration closes", async () => {
    const t = await cup();
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    await signup(t.id, 4);

    await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

    expect((await teams(t.id)).filter((x) => x.is_drafted)).toHaveLength(2);
    await expectEveryTeamInBracket(t.id, 4);

    // Going Live afterwards neither drafts a late team nor re-draws the bracket.
    const before = (await bracketTeams(t.id)).sort();
    await cups.setStatus(t.id, t.organizer, "Live");
    await expectEveryTeamInBracket(t.id, 4);
    expect((await bracketTeams(t.id)).sort()).toEqual(before);
  });

  it("manual close after the scheduled start still drafts before the bracket", async () => {
    const t = await cup();
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    await signup(t.id, 4);
    await postgres.query(
      "UPDATE tournaments SET start = now() - interval '2 minutes' WHERE id = $1",
      [t.id],
    );

    await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

    await expectEveryTeamInBracket(t.id, 4);
    await cups.setStatus(t.id, t.organizer, "Live");
    await expectEveryTeamInBracket(t.id, 4);
  });

  it("check-in ON, automatic close at the deadline: drafted teams are in the bracket", async () => {
    const t = await cup();
    await openWindow(t.id);
    // Registered inside the window, so each is stamped as checked in.
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    await signup(t.id, 4);
    await postgres.query(
      "UPDATE tournaments SET check_in_ends_at = now() - interval '1 second' WHERE id = $1",
      [t.id],
    );

    await runCheckInJob();

    expect(await cups.tournamentStatus(t.id)).toBe("RegistrationClosed");
    await expectEveryTeamInBracket(t.id, 4);
    await cups.setStatus(t.id, t.organizer, "Live");
    await expectEveryTeamInBracket(t.id, 4);
  });

  it("check-in ON, review then continue: the bracket holds every eligible and drafted team", async () => {
    const t = await cup("both", 8);
    // Registered before the window opens, so this one never checked in.
    const missing = await cups.registerTeam(t.id, await fx.team(1));
    await openWindow(t.id);
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    await signup(t.id, 4);
    await postgres.query(
      "UPDATE tournaments SET check_in_ends_at = now() - interval '1 second' WHERE id = $1",
      [t.id],
    );

    await runCheckInJob();
    expect(await cups.tournamentStatus(t.id)).toBe("CheckInReview");

    await registration().continueTournamentCheckIn({
      tournament_id: t.id,
      user: user(t.organizer, "admin"),
    });

    expect(await cups.tournamentStatus(t.id)).toBe("RegistrationClosed");
    const all = await teams(t.id);
    expect(all).toHaveLength(5);
    const playing = all.filter((x) => x.id !== missing);
    expect(playing).toHaveLength(4);
    expect(playing.every((x) => x.eligible && x.seed !== null)).toBe(true);
    const inBracket = (await bracketTeams(t.id)).sort();
    expect(inBracket).toEqual(playing.map((x) => x.id).sort());
  });

  it("starting directly from RegistrationOpen drafts before seeding", async () => {
    const t = await cup();
    await cups.registerTeam(t.id, await fx.team(1));
    await cups.registerTeam(t.id, await fx.team(1));
    await signup(t.id, 4);

    await cups.setStatus(t.id, t.organizer, "Live");

    await expectEveryTeamInBracket(t.id, 4);
  });

  it("teams-only tournaments never draft and keep their bracket", async () => {
    const t = await cup("teams");
    for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(1));

    await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

    expect((await teams(t.id)).filter((x) => x.is_drafted)).toHaveLength(0);
    await expectEveryTeamInBracket(t.id, 4);
  });
});
