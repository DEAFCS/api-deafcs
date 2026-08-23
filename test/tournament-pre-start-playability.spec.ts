import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// "Prepared before start" must not mean "playable before start".
//
// Live finding: a tournament scheduled for 12:20 whose attendance/registration
// cutoff was 12:15 became genuinely playable at 12:15 -- registration closed,
// the bracket was seeded, round-1 matches were materialized, and because those
// matches were created directly in 'WaitingForCheckIn', match check-in, veto
// and the join/start flow all worked five minutes before kickoff. The
// tournament header still (correctly) read "in 4 minutes".
//
// The fix keeps every bit of the preparation -- bracket, seeds, opponents,
// match rows -- and parks the match in the pre-existing 'Scheduled' status
// until the tournament's real start, which is what the whole playable ladder
// (WaitingForCheckIn -> Veto -> WaitingForServer -> Live) already keys off.
//
// Nothing here touches Swiss/Group/Single/Double elimination generation; the
// bracket is expected to be fully built in every assertion below.
describe("tournament pre-start playability guard (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPreStartPlayabilityTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199978000000n);
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

  // Reproduces the live scenario: a 4-team SingleElimination tournament whose
  // start is `startOffsetMinutes` away, walked to RegistrationClosed (the
  // transition that seeds stage 1 and materializes round-1 matches).
  //
  // Registration has to be opened while the start is still in the future
  // (can_open_tournament_registration refuses a past start), so a negative
  // offset is applied afterwards -- which is exactly what a tournament whose
  // start time has simply arrived looks like in production.
  const closeRegistration = async ({
    startOffsetMinutes,
  }: {
    startOffsetMinutes: number;
  }) => {
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

    const [{ start }] = await postgres.query<Array<{ start: Date }>>(
      "SELECT start FROM tournaments WHERE id = $1",
      [tournament.id],
    );
    return { tournament, start };
  };

  const round1 = (tournamentId: string) =>
    postgres.query<
      Array<{
        id: string;
        status: string;
        scheduled_at: Date | null;
        cancels_at: Date | null;
        team_1: string | null;
        team_2: string | null;
      }>
    >(
      `SELECT m.id, m.status, m.scheduled_at, m.cancels_at,
              tb.tournament_team_id_1 AS team_1,
              tb.tournament_team_id_2 AS team_2
         FROM matches m
         JOIN tournament_brackets tb ON tb.match_id = m.id
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = $1 AND tb.round = 1`,
      [tournamentId],
    );

  describe("between the registration cutoff and the scheduled start (12:15 -> 12:20)", () => {
    // Everything the organizer and teams are supposed to get early still
    // happens: the stage is seeded, brackets exist, and round-1 match rows
    // exist with both opponents attached.
    it("still prepares the bracket, seeds and round-1 match rows", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });

      const brackets = await tfx.getBrackets(tournament.stageIds[0]);
      expect(brackets.length).toBeGreaterThan(0);

      const [{ seeded }] = await postgres.query<Array<{ seeded: number }>>(
        `SELECT COUNT(*)::int AS seeded FROM tournament_teams
          WHERE tournament_id = $1 AND seed IS NOT NULL`,
        [tournament.id],
      );
      expect(seeded).toBe(4);

      const matches = await round1(tournament.id);
      expect(matches.length).toBe(2);
      for (const match of matches) {
        expect(match.team_1).not.toBeNull();
        expect(match.team_2).not.toBeNull();
      }
    });

    // Opponents are visible: lineups are populated, so a team can see who it
    // is playing and prepare.
    it("populates both lineups so teams can see their opponent", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      const matches = await round1(tournament.id);

      for (const match of matches) {
        const [{ players }] = await postgres.query<Array<{ players: number }>>(
          `SELECT COUNT(*)::int AS players
             FROM match_lineup_players mlp
             JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
            WHERE ml.match_id = $1`,
          [match.id],
        );
        expect(players).toBeGreaterThan(0);
      }
    });

    // The core regression: the match is parked, not open.
    it("parks round-1 matches in Scheduled, not WaitingForCheckIn", async () => {
      const { tournament, start } = await closeRegistration({
        startOffsetMinutes: 5,
      });

      const [{ status: tournamentStatus }] = await postgres.query<
        Array<{ status: string }>
      >("SELECT status FROM tournaments WHERE id = $1", [tournament.id]);
      expect(tournamentStatus).toBe("RegistrationClosed");

      const matches = await round1(tournament.id);
      for (const match of matches) {
        expect(match.status).toBe("Scheduled");
        // The scheduled start is retained, so the match shows on calendars
        // and the countdown has a real target.
        expect(match.scheduled_at).not.toBeNull();
        expect(
          Math.abs(match.scheduled_at!.getTime() - start.getTime()),
        ).toBeLessThan(2000);
        // Nothing is counting down toward a no-show cancellation yet.
        expect(match.cancels_at).toBeNull();
      }
    });

    // Match check-in cannot be opened by any path while the tournament has
    // not started -- CheckForScheduledMatches' 15-minute-early flip included,
    // which is what this direct UPDATE stands in for.
    it("refuses to open match check-in early", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      const matches = await round1(tournament.id);

      for (const match of matches) {
        await postgres.query(
          `UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1`,
          [match.id],
        );
      }

      for (const match of await round1(tournament.id)) {
        expect(match.status).toBe("Scheduled");
      }
    });

    // Veto and the go-live path are blocked by the same gate, so a match
    // cannot be pushed straight past check-in either.
    it("refuses to start veto or take the match Live early", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      const matches = await round1(tournament.id);

      for (const target of ["Veto", "Live", "WaitingForServer"]) {
        for (const match of matches) {
          await postgres.query(`UPDATE matches SET status = $2 WHERE id = $1`, [
            match.id,
            target,
          ]);
        }
        for (const match of await round1(tournament.id)) {
          expect(match.status).toBe("Scheduled");
        }
      }
    });

    // The guard is a match-status gate, not a permissions gate, so it holds
    // for an organizer session too.
    it("holds for the organizer's own session", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      const matches = await round1(tournament.id);

      await runAsUser(postgres, tournament.organizer, "admin", (query) =>
        query(`UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1`, [
          matches[0].id,
        ]),
      );

      const [after] = await round1(tournament.id);
      expect(after.status).toBe("Scheduled");
    });

    // Cancellation must still work -- the gate only blocks the playable
    // ladder, so tournament reset/cancel paths are unaffected.
    it("still allows the match to be canceled", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      const [match] = await round1(tournament.id);

      await postgres.query(`UPDATE matches SET status = 'Canceled' WHERE id = $1`, [
        match.id,
      ]);

      const [{ status }] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [match.id],
      );
      expect(status).toBe("Canceled");
    });
  });

  describe("at the scheduled start (12:20 / Live)", () => {
    // The tournament going Live releases the parked matches immediately --
    // no waiting for the next CheckForScheduledMatches pass, which would
    // otherwise leave the tournament reading "Live" while its first round
    // still showed as merely scheduled.
    it("opens match check-in as soon as the tournament goes Live", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      for (const match of await round1(tournament.id)) {
        expect(match.status).toBe("Scheduled");
      }

      // Taken Live directly rather than back-dating `start`: the schedule
      // freezes once attendance opens (tbu_tournaments), and production never
      // moves a start anyway, the clock advances. Either way this is the
      // transition CheckForTournamentStart performs.
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");

      for (const match of await round1(tournament.id)) {
        expect(match.status).toBe("WaitingForCheckIn");
      }
    });

    // The deployed check-in deadline semantics are unchanged: the no-show
    // timer is the scheduled start plus check_in_duration, never earlier.
    it("stamps cancels_at at scheduled start + check_in_duration on release", async () => {
      const { tournament, start } = await closeRegistration({
        startOffsetMinutes: 5,
      });

      await tfx.setStatus(tournament.id, tournament.organizer, "Live");

      for (const match of await round1(tournament.id)) {
        expect(match.cancels_at).not.toBeNull();
        const minutesAfterStart =
          (match.cancels_at!.getTime() - start.getTime()) / 60_000;
        expect(minutesAfterStart).toBeGreaterThan(4.9);
        expect(minutesAfterStart).toBeLessThan(5.1);
      }
    });

    // Once Live, the ordinary flow is genuinely back: the same transition
    // the guard refused above now succeeds.
    it("allows veto once the tournament is Live", async () => {
      const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
      await tfx.setStatus(tournament.id, tournament.organizer, "Live");

      const [match] = await round1(tournament.id);
      await postgres.query(`UPDATE matches SET status = 'Veto' WHERE id = $1`, [
        match.id,
      ]);

      const [{ status }] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [match.id],
      );
      expect(status).toBe("Veto");
    });
  });

  // A tournament whose start has already passed by the time registration
  // closes is not "pre-start" at all -- it must keep the existing immediate
  // behavior rather than being parked indefinitely.
  it("a tournament whose start has already passed opens check-in immediately", async () => {
    const { tournament } = await closeRegistration({ startOffsetMinutes: -30 });

    const matches = await round1(tournament.id);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.status).toBe("WaitingForCheckIn");
    }
  });

  // Later rounds materialize while the tournament is already Live, so they
  // are outside the guard entirely -- asserted directly against the helper
  // the trigger uses.
  it("tournament_match_is_pre_start is false once the tournament is Live", async () => {
    const { tournament } = await closeRegistration({ startOffsetMinutes: 5 });
    const [match] = await round1(tournament.id);

    const [before] = await postgres.query<Array<{ pre_start: boolean }>>(
      "SELECT tournament_match_is_pre_start($1) AS pre_start",
      [match.id],
    );
    expect(before.pre_start).toBe(true);

    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const [after] = await postgres.query<Array<{ pre_start: boolean }>>(
      "SELECT tournament_match_is_pre_start($1) AS pre_start",
      [match.id],
    );
    expect(after.pre_start).toBe(false);
  });

  // Non-tournament matches must be completely untouched by the guard.
  it("leaves a plain non-tournament match alone", async () => {
    const optionsId = await fx.matchOptions();
    const [{ id }] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (status, match_options_id, scheduled_at)
       VALUES ('Scheduled', $1, now() + interval '5 minutes') RETURNING id`,
      [optionsId],
    );

    await postgres.query(
      `UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1`,
      [id],
    );

    const [{ status }] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [id],
    );
    expect(status).toBe("WaitingForCheckIn");
  });
});
