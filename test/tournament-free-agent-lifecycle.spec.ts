import { PostgresService } from "../src/postgres/postgres.service";
import { CancelInvalidTournaments } from "../src/matches/jobs/CancelInvalidTournaments";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  SqlTestDb,
  seedRegionWithServer,
} from "./utils/sql-test-db";

// A Free Agents or Both tournament must not be cancelled for "too few teams"
// before its pool has been drafted: the complete teams may exist only as
// sign-ups. The decision uses the real draft, never pool / team size, and the
// bracket is drawn only from the final team set. Reset to Setup returns a
// cancelled tournament to a state that can open registration and draft again.
describe("Free Agent tournament lifecycle: min-team decision and reset (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("FreeAgentLifecycle");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199969800000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600000);
  afterAll(async () => {
    await db?.stop();
  });

  async function cup({
    type = "Competitive",
    registrationType = "free_agents",
    minTeams = 4,
    maxTeams = 16,
    version = 2,
  }: {
    type?: string;
    registrationType?: string;
    minTeams?: number;
    maxTeams?: number;
    version?: number;
  } = {}) {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams, maxTeams }],
      type,
      version,
    );
    if (version === 2) {
      await postgres.query(
        "UPDATE tournaments SET registration_type = $2 WHERE id = $1",
        [t.id, registrationType],
      );
    }
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  }

  async function signup(tournamentId: string, count: number) {
    const players = await fx.players(count);
    for (const p of players) {
      await postgres.query(
        "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
        [tournamentId, p],
      );
    }
    return players;
  }

  const startPassed = (id: string) =>
    postgres.query(
      "UPDATE tournaments SET start = now() - interval '1 minute' WHERE id = $1",
      [id],
    );

  const runJob = async () => {
    const job = new CancelInvalidTournaments({ log: jest.fn() } as any, postgres);
    return job.process();
  };

  const status = (id: string) => cups.tournamentStatus(id);

  const teamCount = async (id: string) => {
    const [r] = await postgres.query<Array<{ all: string; drafted: string }>>(
      "SELECT count(*)::text AS all, count(*) FILTER (WHERE is_drafted)::text AS drafted FROM tournament_teams WHERE tournament_id = $1",
      [id],
    );
    return { all: Number(r.all), drafted: Number(r.drafted) };
  };

  const poolStatuses = async (id: string) => {
    const rows = await postgres.query<Array<{ status: string; count: string }>>(
      "SELECT status, count(*)::text FROM tournament_free_agents WHERE tournament_id = $1 GROUP BY status",
      [id],
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  };

  // Every team slot in the stage; a team that skips round 1 on a bye is still
  // placed in a later round.
  async function bracketTeams(tournamentId: string) {
    const rows = await postgres.query<
      Array<{ a: string | null; b: string | null }>
    >(
      `SELECT tb.tournament_team_id_1 AS a, tb.tournament_team_id_2 AS b
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1`,
      [tournamentId],
    );
    return rows.flatMap((r) => [r.a, r.b]).filter((x): x is string => !!x);
  }

  describe("Free Agents only", () => {
    it("50 eligible solo players in 5v5 are not cancelled at the start time, and become 10 teams", async () => {
      const t = await cup();
      await signup(t.id, 50);
      await startPassed(t.id);

      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");
      // The probe drafts and discards: nothing was created or marked.
      expect(await teamCount(t.id)).toEqual({ all: 0, drafted: 0 });
      expect(await poolStatuses(t.id)).toEqual({ registered: 50 });

      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await teamCount(t.id)).toEqual({ all: 10, drafted: 10 });
      expect(new Set(await bracketTeams(t.id)).size).toBe(10);
      await cups.setStatus(t.id, t.organizer, "Live");
      expect(await status(t.id)).toBe("Live");
      expect(await teamCount(t.id)).toEqual({ all: 10, drafted: 10 });
    });

    it("20 solo players make exactly 4 teams and are kept", async () => {
      const t = await cup();
      await signup(t.id, 20);
      await startPassed(t.id);
      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect((await teamCount(t.id)).all).toBe(4);
    });

    it("19 solo players make only 3 complete teams, so the decision uses 3, not 19 / 5", async () => {
      const t = await cup();
      await signup(t.id, 19);
      await startPassed(t.id);

      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("CancelledMinTeams");
      // Nothing the probe did survives the cancellation.
      expect(await teamCount(t.id)).toEqual({ all: 0, drafted: 0 });
      expect(await poolStatuses(t.id)).toEqual({ registered: 19 });
    });

    it("enough players but parties that cannot be packed: only packable teams count", async () => {
      // Twenty players are "four teams of five" by division. As five parties
      // of four each party needs its own team and none can be filled, so the
      // draft makes no team at all.
      const t = await cup({ minTeams: 4, maxTeams: 8 });
      const players = await fx.players(20);
      const parties = [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ];
      for (const [i, p] of players.entries()) {
        await postgres.query(
          "INSERT INTO tournament_free_agents (tournament_id, player_steam_id, party_id) VALUES ($1, $2, $3)",
          [t.id, p, parties[Math.floor(i / 4)]],
        );
      }
      await startPassed(t.id);

      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("CancelledMinTeams");
      expect(await teamCount(t.id)).toEqual({ all: 0, drafted: 0 });
    });

    it("running the job again changes nothing (no duplicate teams, no repeated cancel)", async () => {
      const t = await cup();
      await signup(t.id, 20);
      await startPassed(t.id);
      await runJob();
      await runJob();
      expect(await teamCount(t.id)).toEqual({ all: 0, drafted: 0 });
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect((await teamCount(t.id)).drafted).toBe(4);
      // Already closed: the job has nothing to look at.
      expect(await runJob()).toBe(0);
      await cups.setStatus(t.id, t.organizer, "Live");
      expect((await teamCount(t.id)).drafted).toBe(4);
    });
  });

  describe("Both", () => {
    it("3 premade Wingman teams + 4 eligible Free Agents are 5 teams, all in the bracket", async () => {
      const t = await cup({ type: "Wingman", registrationType: "both", maxTeams: 8 });
      for (let i = 0; i < 3; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 4);
      await startPassed(t.id);

      expect(await runJob()).toBe(0);
      expect(await status(t.id)).toBe("RegistrationOpen");

      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await teamCount(t.id)).toEqual({ all: 5, drafted: 2 });
      const inBracket = await bracketTeams(t.id);
      expect(new Set(inBracket).size).toBe(5);
      const all = await postgres.query<Array<{ id: string; seed: number }>>(
        "SELECT id, seed FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(all.every((x) => x.seed !== null)).toBe(true);
      expect([...inBracket].sort()).toEqual(all.map((x) => x.id).sort());
    });

    it("3 premade teams and a single Free Agent are still short and are cancelled", async () => {
      const t = await cup({ type: "Wingman", registrationType: "both", maxTeams: 8 });
      for (let i = 0; i < 3; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 1);
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("CancelledMinTeams");
    });
  });

  describe("start paths", () => {
    it("manual Start from RegistrationOpen drafts first and starts a field only the pool can fill", async () => {
      const t = await cup({ type: "Wingman" });
      await signup(t.id, 8); // four teams of two
      await cups.setStatus(t.id, t.organizer, "Live");
      expect(await status(t.id)).toBe("Live");
      expect((await teamCount(t.id)).drafted).toBe(4);
      expect(new Set(await bracketTeams(t.id)).size).toBe(4);
    });

    it("manual Start with a genuinely short field becomes CancelledMinTeams", async () => {
      const t = await cup({ type: "Wingman" });
      await signup(t.id, 6); // three teams of two, four needed
      await cups.setStatus(t.id, t.organizer, "Live");
      expect(await status(t.id)).toBe("CancelledMinTeams");
    });

    it("Start is offered while the pool can still make the field, and not otherwise", async () => {
      const startable = async (id: string, organizer: string) => {
        const [r] = await postgres.query<Array<{ ok: boolean }>>(
          "SELECT can_start_tournament(t, json_build_object('x-hasura-role', 'administrator', 'x-hasura-user-id', $2::text)) AS ok FROM tournaments t WHERE t.id = $1",
          [id, organizer],
        );
        return r.ok;
      };
      const full = await cup({ type: "Wingman" });
      await signup(full.id, 8);
      expect(await startable(full.id, full.organizer)).toBe(true);

      const empty = await cup({ type: "Wingman" });
      await signup(empty.id, 2);
      expect(await startable(empty.id, empty.organizer)).toBe(false);
    });

    it("manual Close after the scheduled start drafts before the bracket and before any cancellation", async () => {
      const t = await cup({ type: "Wingman" });
      await signup(t.id, 8);
      await startPassed(t.id);
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await status(t.id)).toBe("RegistrationClosed");
      expect(new Set(await bracketTeams(t.id)).size).toBe(4);
    });

    it("registration_version 1 keeps the old rule: short at the start time means cancelled", async () => {
      const t = await cup({ type: "Wingman", version: 1 });
      for (let i = 0; i < 2; i++) await cups.registerTeam(t.id, await fx.team(1));
      await startPassed(t.id);
      expect(await runJob()).toBe(1);
      expect(await status(t.id)).toBe("CancelledMinTeams");
    });
  });

  describe("Reset to Setup", () => {
    const admin = (organizer: string) =>
      JSON.stringify({ "x-hasura-role": "administrator", "x-hasura-user-id": organizer });

    const canOpen = async (id: string, organizer: string) => {
      const [r] = await postgres.query<Array<{ ok: boolean }>>(
        "SELECT can_open_tournament_registration(t, $2::json) AS ok FROM tournaments t WHERE t.id = $1",
        [id, admin(organizer)],
      );
      return r.ok;
    };

    // Cancelled after the draft: the field was drafted, then fell short.
    async function cancelledAfterDraft() {
      const t = await cup({ type: "Wingman", registrationType: "both", minTeams: 6, maxTeams: 8 });
      for (let i = 0; i < 3; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 4);
      await cups.setStatus(t.id, t.organizer, "Live");
      return t;
    }

    it("a tournament cancelled after the draft is returned to a reusable pre-registration state", async () => {
      const t = await cancelledAfterDraft();
      expect(await status(t.id)).toBe("CancelledMinTeams");
      expect((await teamCount(t.id)).drafted).toBe(2);
      expect(await poolStatuses(t.id)).toEqual({ drafted: 4 });

      await cups.setStatus(t.id, t.organizer, "Setup");

      expect(await status(t.id)).toBe("Setup");
      // Registered teams stay; the generated ones are gone.
      expect(await teamCount(t.id)).toEqual({ all: 3, drafted: 0 });
      // Everyone the draft placed is back in the pool, on no team.
      expect(await poolStatuses(t.id)).toEqual({ registered: 4 });
      const [seeds] = await postgres.query<Array<{ n: string }>>(
        "SELECT count(seed)::text AS n FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(Number(seeds.n)).toBe(0);
    });

    it("Open Registration is offered after Reset with a future start, and refused only when the start has passed", async () => {
      const t = await cancelledAfterDraft();
      await cups.setStatus(t.id, t.organizer, "Setup");

      // The start time of the cancelled tournament has passed.
      await startPassed(t.id);
      expect(await canOpen(t.id, t.organizer)).toBe(false);

      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '5 minutes' WHERE id = $1",
        [t.id],
      );
      expect(await canOpen(t.id, t.organizer)).toBe(true);
    });

    it("reopened, the pool is drafted again and the whole field is in the bracket", async () => {
      const t = await cancelledAfterDraft();
      await cups.setStatus(t.id, t.organizer, "Setup");
      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '5 minutes' WHERE id = $1",
        [t.id],
      );
      await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query("UPDATE tournament_stages SET min_teams = 4 WHERE tournament_id = $1", [t.id]);
      await signup(t.id, 2); // joins the four already back in the pool

      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await teamCount(t.id)).toEqual({ all: 6, drafted: 3 });
      expect(new Set(await bracketTeams(t.id)).size).toBe(6);
    });

    it("a waitlisted player who is no longer eligible is withdrawn, not returned to the pool", async () => {
      const t = await cancelledAfterDraft();
      const extra = (await signup(t.id, 0), undefined);
      void extra;
      const [waitlisted] = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id::text FROM tournament_free_agents WHERE tournament_id = $1 LIMIT 1",
        [t.id],
      );
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'waitlisted', tournament_team_id = NULL WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, waitlisted.player_steam_id],
      );
      await postgres.query(
        "INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id) VALUES ($1, 'ban', $2)",
        [waitlisted.player_steam_id, t.organizer],
      );

      await cups.setStatus(t.id, t.organizer, "Setup");

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournament_free_agents WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, waitlisted.player_steam_id],
      );
      expect(row.status).toBe("withdrawn");
    });

    it("the user-reported sequence: cancel, reset, start in 5 minutes, Open Registration is available", async () => {
      // Short at the start time with a pool that is not enough: really cancelled.
      const t = await cup({ type: "Wingman", registrationType: "both", maxTeams: 8 });
      for (let i = 0; i < 3; i++) await cups.registerTeam(t.id, await fx.team(1));
      await signup(t.id, 1);
      await startPassed(t.id);
      await runJob();
      expect(await status(t.id)).toBe("CancelledMinTeams");

      await cups.setStatus(t.id, t.organizer, "Setup");
      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '5 minutes' WHERE id = $1",
        [t.id],
      );

      expect(await canOpen(t.id, t.organizer)).toBe(true);
      await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
      expect(await status(t.id)).toBe("RegistrationOpen");
    });
  });
});
