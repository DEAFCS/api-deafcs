import { PostgresService } from "../src/postgres/postgres.service";
import { CancelInvalidTournaments } from "../src/matches/jobs/CancelInvalidTournaments";
import { CheckForTournamentStart } from "../src/matches/jobs/CheckForTournamentStart";
import { ProcessTournamentCheckIn } from "../src/matches/jobs/ProcessTournamentCheckIn";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  SqlTestDb,
  seedRegionWithServer,
} from "./utils/sql-test-db";

// With tournament check-in OFF nothing used to close a RegistrationOpen
// tournament, so a valid one sat open past its start until an organizer clicked
// Close or Start. The scheduled job now starts it exactly like the Start button:
// the Free Agent pool is drafted, the final field is checked against the
// minimum, the bracket is drawn and the tournament goes Live, with no click.
describe("scheduled start of a tournament without check-in (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ScheduledStart");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199973000000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600000);
  afterAll(async () => {
    await db?.stop();
  });

  async function cup({
    type = "Wingman",
    registrationType = "both",
    minTeams = 4,
    maxTeams = 8,
    version = 2,
    random = false,
  }: {
    type?: string;
    registrationType?: string;
    minTeams?: number;
    maxTeams?: number;
    version?: number;
    random?: boolean;
  } = {}) {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams, maxTeams }],
      type,
      version,
      random,
    );
    if (version === 2 && !random) {
      await postgres.query("UPDATE tournaments SET registration_type = $2 WHERE id = $1", [t.id, registrationType]);
    }
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  }

  const signup = async (id: string, count: number) => {
    const players = await fx.players(count);
    for (const p of players) {
      await postgres.query("INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)", [id, p]);
    }
    return players;
  };
  const startPassed = (id: string) =>
    postgres.query("UPDATE tournaments SET start = now() - interval '1 minute' WHERE id = $1", [id]);
  const runJob = () =>
    new CancelInvalidTournaments({ log: jest.fn() } as any, postgres).process();
  const status = (id: string) => cups.tournamentStatus(id);
  const teamCount = async (id: string) => {
    const [r] = await postgres.query<Array<{ all: string; drafted: string }>>(
      "SELECT count(*)::text AS all, count(*) FILTER (WHERE is_drafted)::text AS drafted FROM tournament_teams WHERE tournament_id = $1",
      [id],
    );
    return { all: Number(r.all), drafted: Number(r.drafted) };
  };
  const bracketTeams = async (id: string) => {
    const rows = await postgres.query<Array<{ a: string | null; b: string | null }>>(
      `SELECT tb.tournament_team_id_1 AS a, tb.tournament_team_id_2 AS b
         FROM tournament_brackets tb JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1`,
      [id],
    );
    return new Set(rows.flatMap((r) => [r.a, r.b]).filter((x): x is string => !!x));
  };
  const matchCount = async (id: string) => {
    const [r] = await postgres.query<Array<{ n: string; d: string }>>(
      `SELECT count(tb.match_id)::text AS n, count(DISTINCT tb.match_id)::text AS d
         FROM tournament_brackets tb JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1`,
      [id],
    );
    expect(r.n).toBe(r.d); // no match shared or duplicated
    return Number(r.n);
  };

  describe("check-in off", () => {
    it("Both: 2 premade Wingman teams + 8 Free Agents become 6 teams in the bracket and go Live with no click", async () => {
      const t = await cup();
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 8);
      await startPassed(t.id);
      expect(await status(t.id)).toBe("RegistrationOpen");

      expect(await runJob()).toBe(1);

      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 6, drafted: 4 });
      const all = await postgres.query<Array<{ id: string; seed: number | null }>>(
        "SELECT id, seed FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(all.every((x) => x.seed !== null)).toBe(true);
      expect([...(await bracketTeams(t.id))].sort()).toEqual(all.map((x) => x.id).sort());
      expect(await matchCount(t.id)).toBeGreaterThan(0);
    });

    it("Free Agents only: 8 Wingman Free Agents make 4 teams and the tournament goes Live", async () => {
      const t = await cup({ registrationType: "free_agents" });
      await signup(t.id, 8);
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 4, drafted: 4 });
      expect((await bracketTeams(t.id)).size).toBe(4);
    });

    it("Free Agents only: 50 Competitive Free Agents make 10 teams where the stage allows", async () => {
      const t = await cup({ type: "Competitive", registrationType: "free_agents", maxTeams: 16 });
      await signup(t.id, 50);
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 10, drafted: 10 });
      expect((await bracketTeams(t.id)).size).toBe(10);
    });

    it("Teams only: enough registered teams close and go Live", async () => {
      const t = await cup({ registrationType: "teams" });
      for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(1));
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 4, drafted: 0 });
      expect((await bracketTeams(t.id)).size).toBe(4);
    });

    it("a genuinely insufficient final field is cancelled, not started", async () => {
      const t = await cup();
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 2); // one generated team: 3 teams, 4 needed
      await startPassed(t.id);
      await runJob();
      expect(await status(t.id)).toBe("CancelledMinTeams");
    });

    it("a tournament whose start has not been reached is left alone", async () => {
      const t = await cup();
      for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(1));
      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");
    });
  });

  describe("idempotent and race safe", () => {
    it("running the scheduler repeatedly drafts once and draws one bracket", async () => {
      const t = await cup();
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 8);
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      const matches = await matchCount(t.id);
      expect(await runJob()).toBe(0);
      expect(await runJob()).toBe(0);
      expect(await teamCount(t.id)).toEqual({ all: 6, drafted: 4 });
      expect(await matchCount(t.id)).toBe(matches);
      // The next job in the chain finds nothing left to start.
      const next = new CheckForTournamentStart({ log: jest.fn(), error: jest.fn() } as any, {
        mutation: async () => ({ update_tournaments: { affected_rows: 0 } }),
      } as any);
      await next.process();
      expect(await status(t.id)).toBe("Live");
    });

    it("an organizer's manual Start racing the scheduler starts it once", async () => {
      const t = await cup();
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 8);
      await startPassed(t.id);

      const results = await Promise.allSettled([
        runJob(),
        cups.setStatus(t.id, t.organizer, "Live"),
        runJob(),
      ]);

      expect(results.filter((r) => r.status === "rejected").length).toBeLessThanOrEqual(1);
      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 6, drafted: 4 });
      expect((await bracketTeams(t.id)).size).toBe(6);
      await matchCount(t.id);
    });

    it("a tournament an organizer already started is not started again", async () => {
      const t = await cup();
      for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(1));
      await cups.setStatus(t.id, t.organizer, "Live");
      await startPassed(t.id).catch(() => undefined);
      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("Live");
    });
  });

  describe("check-in on and legacy are untouched", () => {
    it("check-in on: the scheduler does not close or start it; the check-in job and start job do, with only checked-in Free Agents drafted", async () => {
      const t = await cup();
      await postgres.query(
        "UPDATE tournaments SET check_in_required = true, check_in_setting = 'Captains', start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );
      await postgres.query("UPDATE tournaments SET check_in_ends_at = now() + interval '15 minutes' WHERE id = $1", [t.id]);
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      const players = await signup(t.id, 8);
      // Four of the Free Agents never confirm.
      for (const p of players.slice(4)) {
        await postgres.query(
          "UPDATE tournament_free_agents SET checked_in_at = NULL WHERE tournament_id = $1 AND player_steam_id = $2",
          [t.id, p],
        );
      }
      await postgres.query("UPDATE tournaments SET check_in_ends_at = now() - interval '1 second' WHERE id = $1", [t.id]);

      // The scheduled-start pass leaves a check-in tournament to its own path.
      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");

      await new ProcessTournamentCheckIn({ log: jest.fn() } as any, postgres, { notifyPlayers: jest.fn() } as any).process();

      expect(await status(t.id)).toBe("RegistrationClosed");
      expect(await teamCount(t.id)).toEqual({ all: 4, drafted: 2 });
      const rows = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournament_free_agents WHERE tournament_id = $1 AND player_steam_id = ANY($2::bigint[])",
        [t.id, players.slice(4)],
      );
      expect(rows.every((r) => r.status === "waitlisted")).toBe(true);
    });

    it("registration_version 1 is not started by this pass", async () => {
      const t = await cup({ version: 1 });
      for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(1));
      await startPassed(t.id);
      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");
    });

    it("a Random tournament that needs check-in is not started by this pass", async () => {
      const t = await cups.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Competitive",
        2,
        true,
      );
      await postgres.query("UPDATE tournaments SET check_in_required = true WHERE id = $1", [t.id]);
      await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
      await signup(t.id, 20);
      await postgres.query(
        "UPDATE tournaments SET start = now() - interval '1 minute' WHERE id = $1",
        [t.id],
      ).catch(() => undefined);
      const before = await status(t.id);
      await runJob();
      expect(await status(t.id)).toBe(before);
      expect(await teamCount(t.id)).toEqual({ all: 0, drafted: 0 });
    });
  });
});
