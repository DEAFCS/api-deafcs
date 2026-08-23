import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the new Check-in Time deadline: resolve_match_check_in() and the
// tbu_matches WaitingForCheckIn branch that now sources cancels_at from
// match_options.check_in_duration for tournament matches instead of
// auto_cancel_duration, while leaving non-tournament matches (see
// match-lifecycle.spec.ts's "entering the check-in window..." test) on the
// unchanged auto_cancel_duration path.
describe("tournament check-in time (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentCheckInTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199981000000n);
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
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  // Mirrors TournamentFixtures.launch(), but stops before the Live
  // transition so the tournament's match_options can be tuned first --
  // schedule_tournament_match() resolves check-in settings from the
  // tournament's match_options at match-creation time.
  const launchWithOptions = async (
    optionsOverrides: Record<string, unknown>,
  ) => {
    const tournament = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
      "Wingman",
    );
    const [{ match_options_id: matchOptionsId }] = await postgres.query<
      Array<{ match_options_id: string }>
    >("SELECT match_options_id FROM tournaments WHERE id = $1", [
      tournament.id,
    ]);

    const keys = Object.keys(optionsOverrides);
    if (keys.length > 0) {
      const set = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
      await postgres.query(
        `UPDATE match_options SET ${set} WHERE id = $1`,
        [matchOptionsId, ...keys.map((key) => optionsOverrides[key])],
      );
    }

    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    await tfx.registerTeam(tournament.id, await fx.team(1));
    await tfx.registerTeam(tournament.id, await fx.team(1));
    await tfx.registerTeam(tournament.id, await fx.team(1));
    await tfx.registerTeam(tournament.id, await fx.team(1));
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationClosed");
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const [bracket] = await tfx.getBrackets(tournament.stageIds[0]);
    return { tournament, matchOptionsId, matchId: bracket.match_id! };
  };

  const getMatch = async (id: string) => {
    const [match] = await postgres.query<
      Array<{ status: string; cancels_at: Date | null }>
    >("SELECT status, cancels_at FROM matches WHERE id = $1", [id]);
    return match;
  };

  // These tests are about WHICH duration is applied (check_in_duration vs
  // auto_cancel_duration), not about the baseline it is added to.
  // schedule_tournament_match() bases a not-yet-started tournament match on
  // the tournament's scheduled start (see
  // tournament-match-prep-timeout.spec.ts), and TournamentFixtures starts
  // tournaments a day out, so the deadline is measured from that start
  // rather than from now.
  const minutesAfterScheduledStart = async (
    tournamentId: string,
    cancelsAt: Date,
  ) => {
    const [{ start }] = await postgres.query<Array<{ start: Date }>>(
      "SELECT start FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    return (cancelsAt.getTime() - start.getTime()) / 60_000;
  };

  it("uses check_in_duration (not auto_cancel_duration) for a Captains check-in tournament match", async () => {
    const { tournament, matchId } = await launchWithOptions({
      check_in_setting: "Captains",
      check_in_duration: 5,
    });

    const match = await getMatch(matchId);
    expect(match.status).toBe("WaitingForCheckIn");
    expect(match.cancels_at).not.toBeNull();

    const minutesOut = await minutesAfterScheduledStart(
      tournament.id,
      match.cancels_at!,
    );
    // 5 minutes, not the 15-minute auto_cancel_duration default.
    expect(minutesOut).toBeGreaterThan(3);
    expect(minutesOut).toBeLessThan(7);
  });

  it("uses check_in_duration for a Players check-in tournament match", async () => {
    const { tournament, matchId } = await launchWithOptions({
      check_in_setting: "Players",
      check_in_duration: 5,
    });

    const match = await getMatch(matchId);
    const minutesOut = await minutesAfterScheduledStart(
      tournament.id,
      match.cancels_at!,
    );
    expect(minutesOut).toBeGreaterThan(3);
    expect(minutesOut).toBeLessThan(7);
  });

  it("falls back to the global check_in_duration setting when unset", async () => {
    const { tournament, matchId } = await launchWithOptions({
      check_in_setting: "Captains",
      // check_in_duration left NULL: falls back to the global setting
      // default of 5 minutes, mirroring auto_cancel_duration's own
      // get_int_setting(..., 15) fallback pattern.
    });

    const match = await getMatch(matchId);
    const minutesOut = await minutesAfterScheduledStart(
      tournament.id,
      match.cancels_at!,
    );
    expect(minutesOut).toBeGreaterThan(3);
    expect(minutesOut).toBeLessThan(7);
  });

  it("sets no automatic check-in timer when check_in_setting is Admin", async () => {
    const { matchId } = await launchWithOptions({
      check_in_setting: "Admin",
      check_in_duration: 5,
    });

    const match = await getMatch(matchId);
    expect(match.status).toBe("WaitingForCheckIn");
    expect(match.cancels_at).toBeNull();
  });
});
