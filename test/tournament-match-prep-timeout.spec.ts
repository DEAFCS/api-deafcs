import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Covers the cancels_at timeout baseline for tournament matches that are
// materialized BEFORE their scheduled start (the pre-kickoff preparation
// window). schedule_tournament_match() now derives matches.scheduled_at from
// the most specific schedule available -- the bracket's own scheduled_at,
// else the tournament's start, else now() -- so tbu_matches' existing
// `cancels_at = COALESCE(scheduled_at, NOW()) + duration` lands AFTER the
// scheduled start instead of before it.
//
// Before this fix a round-1 match materialized at 18:45 for a 19:00
// tournament fell back to now(), producing cancels_at = 18:50: a check-in
// countdown that expired ten minutes before the tournament had even started.
describe("tournament match prep-window timeout baseline (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMatchPrepTimeoutTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199982000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  // Builds a 4-team SingleElimination tournament with an explicit start
  // offset and check-in configuration, then walks it to the point where
  // round-1 matches are materialized (the RegistrationClosed transition,
  // which is what seeds and schedules them).
  const launch = async ({
    startOffsetMinutes,
    checkInDuration = 5,
    goLive = false,
  }: {
    startOffsetMinutes: number;
    checkInDuration?: number;
    goLive?: boolean;
  }) => {
    const tournament = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Wingman",
    );
    const [{ match_options_id: matchOptionsId }] = await postgres.query<
      Array<{ match_options_id: string }>
    >("SELECT match_options_id FROM tournaments WHERE id = $1", [tournament.id]);

    await postgres.query(
      `UPDATE match_options SET check_in_setting = 'Captains', check_in_duration = $2 WHERE id = $1`,
      [matchOptionsId, checkInDuration],
    );

    // Registration must be opened while the start is still ahead
    // (can_open_tournament_registration refuses a past start), so the real
    // offset is applied afterwards -- which is also what a tournament whose
    // start time has simply arrived looks like in production.
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await postgres.query(
      `UPDATE tournaments SET start = now() + ($2 || ' minutes')::interval WHERE id = $1`,
      [tournament.id, startOffsetMinutes],
    );
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    if (goLive) {
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");
    }

    const [{ start }] = await postgres.query<Array<{ start: Date }>>(
      "SELECT start FROM tournaments WHERE id = $1",
      [tournament.id],
    );
    return { tournament, matchOptionsId, start };
  };

  const round1Matches = async (tournamentId: string) =>
    postgres.query<Array<{ id: string; status: string; cancels_at: Date | null }>>(
      `SELECT m.id, m.status, m.cancels_at
       FROM matches m
       JOIN tournament_brackets tb ON tb.match_id = m.id
       JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       WHERE ts.tournament_id = $1 AND tb.round = 1`,
      [tournamentId],
    );

  // Case 1 + 4: the deadline is the scheduled start plus the normal
  // check-in duration -- not "now + duration", and not absent.
  //
  // goLive is required now: a match materialized before its tournament's
  // start is parked in 'Scheduled' (prepared, not playable -- see
  // tournament-pre-start-playability.spec.ts), and a Scheduled match
  // deliberately carries no cancels_at. The deadline is stamped when the
  // tournament actually starts, and the value it lands on is exactly what
  // this test is about.
  it("materialized 15 minutes early: cancels_at is scheduled start + check_in_duration (19:00 -> 19:05)", async () => {
    const { tournament, start } = await launch({
      startOffsetMinutes: 15,
      checkInDuration: 5,
      goLive: true,
    });

    const matches = await round1Matches(tournament.id);
    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      expect(match.cancels_at).not.toBeNull();
      const deltaFromStartMinutes =
        (match.cancels_at!.getTime() - start.getTime()) / 60_000;
      // Exactly the check-in duration after the tournament's start, within
      // a second of clock skew.
      expect(deltaFromStartMinutes).toBeGreaterThan(4.9);
      expect(deltaFromStartMinutes).toBeLessThan(5.1);
    }
  });

  // Case 2: the prep window prepares the match without opening it. Match
  // check-in used to start here, which is what made a 12:20 tournament
  // playable at 12:15; it now waits for the tournament's real start.
  it("match check-in is NOT open during the prep window, before the tournament is Live", async () => {
    const { tournament } = await launch({ startOffsetMinutes: 15 });

    const [{ status: tournamentStatus }] = await postgres.query<
      Array<{ status: string }>
    >("SELECT status FROM tournaments WHERE id = $1", [tournament.id]);
    expect(tournamentStatus).toBe("RegistrationClosed");

    const matches = await round1Matches(tournament.id);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.status).toBe("Scheduled");
    }
  });

  // Case 3: nothing expires before the tournament starts. Asserted two ways:
  // once open, the deadline itself is still in the future and past the start,
  // and the match is outside CancelExpiredMatches' selection criteria
  // throughout.
  it("does not become cancel-eligible before the scheduled start", async () => {
    const { tournament, start } = await launch({
      startOffsetMinutes: 15,
      checkInDuration: 5,
      goLive: true,
    });

    const matches = await round1Matches(tournament.id);
    for (const match of matches) {
      expect(match.cancels_at!.getTime()).toBeGreaterThan(Date.now());
      expect(match.cancels_at!.getTime()).toBeGreaterThan(start.getTime());
    }

    // CancelExpiredMatches selects on
    // (status != Canceled AND is_tournament_match = false AND cancels_at <= now()).
    // Both independent reasons this match is excluded are asserted here so a
    // regression in either is caught.
    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::int AS count
       FROM matches m
       JOIN tournament_brackets tb ON tb.match_id = m.id
       JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       WHERE ts.tournament_id = $1
         AND m.status != 'Canceled'
         AND is_tournament_match(m) = false
         AND m.cancels_at IS NOT NULL
         AND m.cancels_at <= now()`,
      [tournament.id],
    );
    expect(Number(count)).toBe(0);
  });

  // Case 5: the ordinary immediate flow is untouched. A tournament whose
  // start has already passed must still get now()-based timing, because
  // GREATEST(..., now()) clamps a past start.
  it("already-started tournament keeps the existing now()-based timeout", async () => {
    const { tournament } = await launch({
      startOffsetMinutes: -30,
      checkInDuration: 5,
    });

    const matches = await round1Matches(tournament.id);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.cancels_at).not.toBeNull();
      const minutesOut = (match.cancels_at!.getTime() - Date.now()) / 60_000;
      // now + 5, not (start - 30min) + 5 which would already be in the past.
      expect(minutesOut).toBeGreaterThan(4);
      expect(minutesOut).toBeLessThan(6);
      expect(match.cancels_at!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  // Case 6: a bracket carrying its own explicit schedule wins over the
  // tournament-wide start -- the more specific timestamp is used.
  it("a bracket's own scheduled_at takes precedence over the tournament start", async () => {
    const tournament = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Wingman",
    );
    const [{ match_options_id: matchOptionsId }] = await postgres.query<
      Array<{ match_options_id: string }>
    >("SELECT match_options_id FROM tournaments WHERE id = $1", [tournament.id]);
    await postgres.query(
      `UPDATE match_options SET check_in_setting = 'Captains', check_in_duration = 5 WHERE id = $1`,
      [matchOptionsId],
    );
    await postgres.query(
      `UPDATE tournaments SET start = now() + interval '15 minutes' WHERE id = $1`,
      [tournament.id],
    );
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }

    // Seed the bracket without materializing matches yet (auto_start off),
    // stamp an explicit per-bracket schedule further out than the
    // tournament start, then let the bracket schedule itself.
    await postgres.query(
      `UPDATE tournaments SET auto_start = false WHERE id = $1`,
      [tournament.id],
    );
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    // Taken Live before the bracket schedules itself, so this test stays
    // about scheduled_at PRECEDENCE rather than the separate pre-start
    // parking rule (tournament-pre-start-playability.spec.ts). Nothing is
    // auto-scheduled by the transition -- auto_start is off, and the
    // Live-release only opens matches due around kickoff, not one deliberately
    // parked 90 minutes out.
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const brackets = await tfx.getBrackets(tournament.stageIds[0]);
    const target = brackets.find(
      (bracket) =>
        bracket.round === 1 &&
        bracket.tournament_team_id_1 &&
        bracket.tournament_team_id_2,
    )!;
    expect(target.match_id).toBeNull();

    await postgres.query(
      `UPDATE tournament_brackets SET scheduled_at = now() + interval '90 minutes' WHERE id = $1`,
      [target.id],
    );
    const [{ match_id: matchId }] = await postgres.query<
      Array<{ match_id: string }>
    >(
      `SELECT schedule_tournament_match(tb) AS match_id
       FROM tournament_brackets tb WHERE tb.id = $1`,
      [target.id],
    );

    const [match] = await postgres.query<Array<{ cancels_at: Date | null }>>(
      "SELECT cancels_at FROM matches WHERE id = $1",
      [matchId],
    );
    const minutesOut = (match.cancels_at!.getTime() - Date.now()) / 60_000;
    // 90 (bracket schedule) + 5 (check-in), NOT 15 (tournament start) + 5.
    expect(minutesOut).toBeGreaterThan(93);
    expect(minutesOut).toBeLessThan(97);
  });

  // Manual early start: the organizer flipping a 19:00 tournament Live at
  // 18:50 gets the generous 19:05 deadline, not "now + 5" = 18:55. Nothing
  // is counting down before they act.
  it("manual early Start Tournament issues the generous deadline, never a shortened now-based one", async () => {
    const { tournament, start } = await launch({
      startOffsetMinutes: 15,
      checkInDuration: 5,
    });

    for (const match of await round1Matches(tournament.id)) {
      expect(match.status).toBe("Scheduled");
      expect(match.cancels_at).toBeNull();
    }

    // Organizer starts early.
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const after = await round1Matches(tournament.id);
    expect(after.length).toBeGreaterThan(0);
    for (const match of after) {
      expect(match.status).toBe("WaitingForCheckIn");
      expect(match.cancels_at!.getTime()).toBeGreaterThan(start.getTime());
      const minutesAfterStart =
        (match.cancels_at!.getTime() - start.getTime()) / 60_000;
      expect(minutesAfterStart).toBeGreaterThan(4.9);
      expect(minutesAfterStart).toBeLessThan(5.1);
    }
  });
});
