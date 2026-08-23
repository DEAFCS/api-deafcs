import { PostgresService } from "./../src/postgres/postgres.service";
import { HasuraService } from "./../src/hasura/hasura.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { TournamentTeamGenerationService } from "./../src/tournaments/tournament-team-generation.service";
import { ProcessTournamentAttendance } from "./../src/matches/jobs/ProcessTournamentAttendance";
import { ProcessTournamentCheckInExpiry } from "./../src/matches/jobs/ProcessTournamentCheckInExpiry";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// Covers the new shared "tournament attendance" check-in feature end to end
// against a real, migrated Postgres instance (triggers, CHECK constraints,
// and assign_seeds_to_teams/seed_stage all genuinely run -- nothing here is
// mocked except the Hasura GraphQL layer itself, which is stubbed to run the
// equivalent raw SQL, the same "mock only the non-DB pieces" pattern as
// tournament-deletion.spec.ts). Does not touch or re-test Group Stage/Swiss/
// bracket-format behavior, which is covered elsewhere and left unchanged by
// this feature.
describe("tournament attendance check-in (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let generation: TournamentTeamGenerationService;
  let eloOverrides: Map<string, number>;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentAttendanceTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199980000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");

    eloOverrides = new Map();

    // Stands in for HasuraService.query -- only the one query
    // generateTournamentTeamsForTournament actually makes (the eligible
    // signups lookup) needs a fake; everything else it does is raw SQL
    // against the same real postgres instance.
    const hasuraStub = {
      query: async (queryObj: any) => {
        const args = queryObj.tournament_individual_signups.__args.where;
        const tournamentId = args.tournament_id._eq;
        const rows = await postgres.query<
          Array<{ id: string; player_steam_id: string; created_at: string }>
        >(
          `SELECT id, player_steam_id, created_at
           FROM tournament_individual_signups
           WHERE tournament_id = $1
             AND (
               status = 'Registered'
               OR (status = 'Waitlisted' AND checked_in_at IS NOT NULL)
             )`,
          [tournamentId],
        );
        return {
          tournament_individual_signups: rows.map((row) => ({
            id: row.id,
            player_steam_id: row.player_steam_id,
            created_at: row.created_at,
            player: {
              name: `player-${row.player_steam_id}`,
              elo: {
                competitive: eloOverrides.get(row.player_steam_id) ?? 5000,
                wingman: eloOverrides.get(row.player_steam_id) ?? 5000,
              },
            },
          })),
        };
      },
    };

    generation = new TournamentTeamGenerationService(
      { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
      hasuraStub as any,
      postgres,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Matches before tournaments: bracket cascade triggers touch sibling
    // brackets mid-delete otherwise (same ordering as tournament-stages.spec.ts).
    // tournament_teams / tournament_team_roster / tournament_individual_signups
    // all cascade from the tournaments delete -- deleting them directly first
    // hits the roster-below-minimum guard trigger once a tournament has left
    // RegistrationOpen.
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    eloOverrides.clear();
  });

  // --- Settings validation (migration CHECK constraints) ---

  describe("attendance_check_in_*_before_minutes validation", () => {
    const createWith = (open: number, close: number) =>
      (async () => {
        const organizer = await fx.player();
        const optionsId = await fx.matchOptions();
        return postgres.query(
          `INSERT INTO tournaments
             (name, start, organizer_steam_id, match_options_id, status,
              attendance_check_in_open_before_minutes, attendance_check_in_close_before_minutes)
           VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', $4, $5)`,
          [fx.nextName("cup"), organizer, optionsId, open, close],
        );
      })();

    it("accepts the documented default (60/15)", async () => {
      await expect(createWith(60, 15)).resolves.toBeDefined();
    });

    it("rejects open_before below 15", async () => {
      await expect(createWith(10, 5)).rejects.toThrow();
    });

    it("rejects open_before above 240", async () => {
      await expect(createWith(300, 15)).rejects.toThrow();
    });

    it("rejects close_before below 5", async () => {
      await expect(createWith(60, 2)).rejects.toThrow();
    });

    it("rejects close_before above 60", async () => {
      await expect(createWith(120, 90)).rejects.toThrow();
    });

    it("rejects open_before <= close_before", async () => {
      await expect(createWith(15, 15)).rejects.toThrow();
    });

    it("rejects a gap smaller than 5 minutes", async () => {
      await expect(createWith(19, 15)).rejects.toThrow();
    });

    it("new tournaments default to 60/15 without specifying them", async () => {
      const organizer = await fx.player();
      const optionsId = await fx.matchOptions();
      const [row] = await postgres.query<
        Array<{
          attendance_check_in_open_before_minutes: number;
          attendance_check_in_close_before_minutes: number;
        }>
      >(
        `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
         VALUES ($1, now() + interval '1 day', $2, $3, 'Setup')
         RETURNING attendance_check_in_open_before_minutes, attendance_check_in_close_before_minutes`,
        [fx.nextName("cup"), organizer, optionsId],
      );
      expect(row.attendance_check_in_open_before_minutes).toBe(60);
      expect(row.attendance_check_in_close_before_minutes).toBe(15);
    });
  });

  // --- Late-signup auto-check-in (trigger behavior) ---

  describe("late-signup auto-check-in", () => {
    it("Solo Random: a signup made while check-in is open is auto-checked-in", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
        [t.id],
      );

      const player = await fx.player();
      const [signup] = await postgres.query<Array<{ checked_in_at: string | null }>>(
        `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
         VALUES ($1, $2) RETURNING checked_in_at`,
        [t.id, player],
      );

      expect(signup.checked_in_at).not.toBeNull();
    });

    it("Solo Random: a signup made before check-in opens is NOT auto-checked-in", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      // individual_check_in_ends_at left NULL -- check-in not open yet.

      const player = await fx.player();
      const [signup] = await postgres.query<Array<{ checked_in_at: string | null }>>(
        `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
         VALUES ($1, $2) RETURNING checked_in_at`,
        [t.id, player],
      );

      expect(signup.checked_in_at).toBeNull();
    });

    it("team tournaments: a team registered while check-in is open is auto-checked-in", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
        [t.id],
      );

      const team = await fx.team(1);
      const teamId = await tfx.registerTeam(t.id, team);
      const [row] = await postgres.query<Array<{ checked_in_at: string | null }>>(
        `SELECT checked_in_at FROM tournament_teams WHERE id = $1`,
        [teamId],
      );

      expect(row.checked_in_at).not.toBeNull();
    });

    it("team tournaments: a team registered before check-in opens is NOT auto-checked-in", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");

      const team = await fx.team(1);
      const teamId = await tfx.registerTeam(t.id, team);
      const [row] = await postgres.query<Array<{ checked_in_at: string | null }>>(
        `SELECT checked_in_at FROM tournament_teams WHERE id = $1`,
        [teamId],
      );

      expect(row.checked_in_at).toBeNull();
    });
  });

  // --- Solo Random selection: registration priority over ELO ---

  describe("generateTournamentTeamsForTournament: registration priority selection", () => {
    it("selects the earliest eligible signups by created_at, never by ELO", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 3 }],
        "Wingman", // teamSize 2; cap = maxTeams(3) * 2 = 6
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query("UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)", [t.id]);

      // 7 signups, strictly increasing created_at (p1 earliest .. p7 latest).
      // Cap is 6, so the trigger lands p1..p6 Registered and p7 Waitlisted
      // at insert time.
      const steamIds: Array<string> = [];
      for (let i = 0; i < 7; i++) {
        const player = await fx.player();
        steamIds.push(player);
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id, created_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
          [t.id, player, i],
        );
      }
      const [p1, p2, p3, p4, p5, p6, p7] = steamIds;

      // p7 (last by registration time, over the cap) checks in during the
      // window -- eligible per the new rule ("all checked-in players,
      // including currently Waitlisted, may qualify") -- but is given the
      // HIGHEST elo of everyone, including players ahead of it in priority.
      await postgres.query(
        `UPDATE tournament_individual_signups SET checked_in_at = now()
         WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, p7],
      );
      eloOverrides.set(p7, 30000);
      // p1..p6 all deliberately low/mid ELO, unsorted relative to each
      // other, so nothing here coincides with priority order by accident.
      eloOverrides.set(p1, 100);
      eloOverrides.set(p2, 9000);
      eloOverrides.set(p3, 100);
      eloOverrides.set(p4, 9000);
      eloOverrides.set(p5, 100);
      eloOverrides.set(p6, 9000);

      await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");

      const result = await generation.generateTournamentTeamsForTournament(t.id, 2);

      // teamCountByHeadcount = floor(7/2) = 3, capped at maxTeams(3) -> 3
      // teams, 6 players selected, 1 left out.
      expect(result.teamsCreated).toBe(3);
      expect(result.waitlisted).toBe(1);

      const rosterSteamIds = new Set(
        (
          await postgres.query<Array<{ player_steam_id: string }>>(
            `SELECT player_steam_id FROM tournament_team_roster WHERE tournament_id = $1`,
            [t.id],
          )
        ).map((row) => row.player_steam_id),
      );

      // p1..p6 (earliest 6 by registration time) are all seated, despite
      // several of them having far lower ELO than p7.
      for (const steamId of [p1, p2, p3, p4, p5, p6]) {
        expect(rosterSteamIds.has(steamId)).toBe(true);
      }
      // p7 -- highest ELO of anyone, including everyone selected -- is left
      // out purely because it registered latest, proving ELO never
      // decides eligibility.
      expect(rosterSteamIds.has(p7)).toBe(false);

      const [p7signup] = await postgres.query<Array<{ status: string }>>(
        `SELECT status FROM tournament_individual_signups WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, p7],
      );
      expect(p7signup.status).toBe("Waitlisted");
    });

    it("still ELO-balances team assignment among the selected pool", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 2 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query("UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)", [t.id]);

      const steamIds: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const player = await fx.player();
        steamIds.push(player);
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id, created_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
          [t.id, player, i],
        );
      }
      const [p1, p2, p3, p4] = steamIds;
      eloOverrides.set(p1, 20000); // highest -- should captain a team
      eloOverrides.set(p2, 100);
      eloOverrides.set(p3, 9000);
      eloOverrides.set(p4, 8000);

      await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
      const result = await generation.generateTournamentTeamsForTournament(t.id, 2);
      expect(result.teamsCreated).toBe(2);

      const [captainRow] = await postgres.query<Array<{ captain_steam_id: string }>>(
        `SELECT captain_steam_id FROM tournament_teams WHERE tournament_id = $1 AND name = 'Team 1'`,
        [t.id],
      );
      // Round 0 of the snake draft deals the highest-ELO player to Team 1
      // first, and that player becomes the team's captain.
      expect(captainRow.captain_steam_id).toBe(p1);
    });

    it("is idempotent: a second call is a clean no-op, no duplicate teams", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 2 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query("UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)", [t.id]);

      for (let i = 0; i < 4; i++) {
        const player = await fx.player();
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id, created_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
          [t.id, player, i],
        );
      }
      await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");

      const first = await generation.generateTournamentTeamsForTournament(t.id, 2);
      expect(first.teamsCreated).toBe(2);

      const second = await generation.generateTournamentTeamsForTournament(t.id, 2);
      expect(second).toEqual({ teamsCreated: 0, waitlisted: 0 });

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM tournament_teams WHERE tournament_id = $1`,
        [t.id],
      );
      expect(Number(count)).toBe(2);
    });
  });

  // --- Automatic scheduler (ProcessTournamentAttendance) ---

  describe("ProcessTournamentAttendance", () => {
    const makeJob = () =>
      new ProcessTournamentAttendance(
        { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
        postgres,
        generation,
      );

    it("opens the shared attendance window once start - open_before is reached, and is idempotent", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 2 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      // 60/15 defaults -- start 30 minutes out means we're already past
      // start-open_before(60) but well before start-close_before(15).
      await postgres.query(
        `UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1`,
        [t.id],
      );

      const job = makeJob();
      const first = await job.process();
      expect(first.opened).toBe(1);

      const [row] = await postgres.query<Array<{ ends_at: string | null }>>(
        `SELECT individual_check_in_ends_at AS ends_at FROM tournaments WHERE id = $1`,
        [t.id],
      );
      expect(row.ends_at).not.toBeNull();

      // Second tick must not re-open (and thus not reset checked_in_at for
      // anyone) -- individual_check_in_ends_at is already set.
      const second = await job.process();
      expect(second.opened).toBe(0);
    });

    it("Solo Random: finalizes attendance at the close_before cutoff -- closes registration and auto-generates teams by priority", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 2 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query("UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)", [t.id]);
      // start in the past relative to close_before -> window already due.
      await postgres.query(
        `UPDATE tournaments
         SET start = now() + interval '10 minutes',
             individual_check_in_ends_at = now() - interval '1 minute'
         WHERE id = $1`,
        [t.id],
      );

      const steamIds: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const player = await fx.player();
        steamIds.push(player);
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id, created_at, checked_in_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval, now())`,
          [t.id, player, i],
        );
      }

      const job = makeJob();
      const result = await job.process();
      expect(result.finalized).toBe(1);

      const status = await tfx.tournamentStatus(t.id);
      expect(status).toBe("RegistrationClosed");

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM tournament_teams WHERE tournament_id = $1`,
        [t.id],
      );
      expect(Number(count)).toBe(2);
    });

    it("team tournaments: removes a no-show team's registration at the cutoff, leaves checked-in teams alone, then closes registration", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments
         SET start = now() + interval '10 minutes',
             individual_check_in_ends_at = now() - interval '1 minute'
         WHERE id = $1`,
        [t.id],
      );

      // Both teams "registered" before check-in opened (created_at backdated
      // past start - open_before, ie. more than 60 minutes ago).
      const attendingTeam = await fx.team(1);
      const attendingTeamId = await tfx.registerTeam(t.id, attendingTeam);
      const noShowTeam = await fx.team(1);
      const noShowTeamId = await tfx.registerTeam(t.id, noShowTeam);
      await postgres.query(
        `UPDATE tournament_teams SET created_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])`,
        [[attendingTeamId, noShowTeamId]],
      );
      // Only the attending team's captain checked in.
      await postgres.query(
        `UPDATE tournament_teams SET checked_in_at = now() WHERE id = $1`,
        [attendingTeamId],
      );

      const job = makeJob();
      const result = await job.process();
      expect(result.finalized).toBe(1);

      const remaining = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM tournament_teams WHERE tournament_id = $1`,
        [t.id],
      );
      expect(remaining.map((row) => row.id)).toEqual([attendingTeamId]);

      const status = await tfx.tournamentStatus(t.id);
      expect(status).toBe("RegistrationClosed");
    });

    // Full timing regression for the normal-team no-show path: 5 teams
    // registered before check-in opened, 4 check in, 1 does not. At the
    // start-15min cutoff the no-show's registration is removed and the
    // EXISTING seeding/bracket path (tau_tournaments -> update_tournament_stages
    // -> assign_seeds_to_teams -> seed_stage) finalizes against the reduced
    // 4-team set. Nothing here reaches into bracket internals -- it only
    // asserts the engine's own output is coherent.
    it("normal team no-show: reduced team set seeds cleanly, no stale reference to the deleted team, no fake opponent", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments
         SET start = now() + interval '15 minutes',
             individual_check_in_ends_at = now() - interval '1 minute'
         WHERE id = $1`,
        [t.id],
      );

      const teamIds: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        teamIds.push(await tfx.registerTeam(t.id, await fx.team(1)));
      }
      // All registered before check-in opened (older than start - 60min).
      await postgres.query(
        `UPDATE tournament_teams SET created_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])`,
        [teamIds],
      );
      const noShowTeamId = teamIds[4];
      const attendingTeamIds = teamIds.slice(0, 4);
      await postgres.query(
        `UPDATE tournament_teams SET checked_in_at = now() WHERE id = ANY($1::uuid[])`,
        [attendingTeamIds],
      );

      const result = await makeJob().process();
      expect(result.finalized).toBe(1);
      expect(await tfx.tournamentStatus(t.id)).toBe("RegistrationClosed");

      // The no-show's registration is gone; exactly the 4 attending remain.
      const remaining = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM tournament_teams WHERE tournament_id = $1 ORDER BY id`,
        [t.id],
      );
      expect(remaining.map((r) => r.id).sort()).toEqual([...attendingTeamIds].sort());

      // Its roster went with it -- no orphaned roster rows.
      const [{ count: orphanRoster }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count FROM tournament_team_roster WHERE tournament_team_id = $1`,
        [noShowTeamId],
      );
      expect(Number(orphanRoster)).toBe(0);

      // No bracket slot anywhere still points at the deleted team.
      const [{ count: staleRefs }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1
           AND (tb.tournament_team_id_1 = $2 OR tb.tournament_team_id_2 = $2)`,
        [t.id, noShowTeamId],
      );
      expect(Number(staleRefs)).toBe(0);

      // The engine seeded the reduced set itself: 4 eligible teams, each
      // with a distinct seed, and every seeded slot references a team that
      // still exists (no phantom/removed opponent manufactured).
      const seeded = await postgres.query<Array<{ id: string; seed: number | null }>>(
        `SELECT id, seed FROM tournament_teams
         WHERE tournament_id = $1 AND eligible_at IS NOT NULL`,
        [t.id],
      );
      expect(seeded.length).toBe(4);
      const seeds = seeded.map((row) => row.seed).sort();
      expect(seeds).toEqual([1, 2, 3, 4]);

      const [{ count: danglingSlots }] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::int AS count
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1
           AND (
             (tb.tournament_team_id_1 IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM tournament_teams tt WHERE tt.id = tb.tournament_team_id_1))
             OR (tb.tournament_team_id_2 IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM tournament_teams tt WHERE tt.id = tb.tournament_team_id_2))
           )`,
        [t.id],
      );
      expect(Number(danglingSlots)).toBe(0);
    });

    // Documents the ACTUAL player-visible state between the cutoff and the
    // scheduled start, rather than assuming "nothing is playable". Asserted
    // rather than described so a future change to match timing fails here
    // loudly instead of silently shifting when players can act.
    it("18:45-19:00 prep window: first-round matches exist but are parked in Scheduled, not playable, while the tournament is still RegistrationClosed", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments
         SET start = now() + interval '15 minutes',
             individual_check_in_ends_at = now() - interval '1 minute'
         WHERE id = $1`,
        [t.id],
      );

      const teamIds: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        teamIds.push(await tfx.registerTeam(t.id, await fx.team(1)));
      }
      await postgres.query(
        `UPDATE tournament_teams
         SET created_at = now() - interval '2 hours', checked_in_at = now()
         WHERE id = ANY($1::uuid[])`,
        [teamIds],
      );

      await makeJob().process();
      expect(await tfx.tournamentStatus(t.id)).toBe("RegistrationClosed");

      // Round-1 matches are materialized by the EXISTING engine path at seed
      // time (tau_tournament_brackets -> schedule_tournament_match), not by
      // the cron and not by anything this feature added.
      const matches = await postgres.query<Array<{ status: string; cancels_at: string | null }>>(
        `SELECT m.status, m.cancels_at
         FROM matches m
         JOIN tournament_brackets tb ON tb.match_id = m.id
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1`,
        [t.id],
      );

      expect(matches.length).toBeGreaterThan(0);
      // Prepared, not playable. Every materialized match sits in 'Scheduled'
      // -- the bracket and opponents are visible so teams can prepare, but
      // match check-in, veto and the join/start flow stay shut until the
      // tournament's own scheduled start. Live testing found the previous
      // behavior (opening immediately at the cutoff) let a 12:20 tournament
      // actually be played at 12:15. The gate itself is covered in
      // tournament-pre-start-playability.spec.ts.
      for (const match of matches) {
        expect(match.status).toBe("Scheduled");
        expect(match.cancels_at).toBeNull();
      }

      // At kickoff the ordinary flow opens, and the no-show deadline lands
      // AFTER the scheduled start -- never the ten-minutes-before-kickoff
      // deadline the scheduled_at precedence fix removed.
      // schedule_tournament_match() bases matches.scheduled_at on the
      // tournament's start (see tournament-match-prep-timeout.spec.ts for
      // the full precedence rules). The tournament is taken Live with its
      // 19:00 start left alone -- an organizer starting early, which is the
      // stricter case: the deadline must still be 19:05, not 18:50.
      await tfx.setStatus(t.id, t.organizer, "Live");

      const [{ start }] = await postgres.query<Array<{ start: string }>>(
        `SELECT start FROM tournaments WHERE id = $1`,
        [t.id],
      );
      const opened = await postgres.query<
        Array<{ status: string; cancels_at: string | null }>
      >(
        `SELECT m.status, m.cancels_at
         FROM matches m
         JOIN tournament_brackets tb ON tb.match_id = m.id
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1`,
        [t.id],
      );
      for (const match of opened) {
        expect(match.status).toBe("WaitingForCheckIn");
      }
      const timed = opened.filter((match) => match.cancels_at !== null);
      expect(timed.length).toBeGreaterThan(0);
      for (const match of timed) {
        expect(
          new Date(match.cancels_at as string).getTime(),
        ).toBeGreaterThan(new Date(start).getTime());
      }
    });

    // individual_check_in_ends_at is now shared between Solo Random and
    // normal team tournaments, so the older Solo-Random-only expiry job must
    // not touch windows that aren't its own.
    describe("ProcessTournamentCheckInExpiry sharing guards", () => {
      const makeExpiryJob = () =>
        new ProcessTournamentCheckInExpiry(
          { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
          postgres,
        );

      it("ignores a normal team tournament's attendance window entirely", async () => {
        const t = await tfx.createTournament(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
          "Wingman",
        );
        await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
        await postgres.query(
          `UPDATE tournaments
           SET start = now() + interval '15 minutes',
               individual_check_in_ends_at = now() - interval '1 minute'
           WHERE id = $1`,
          [t.id],
        );

        const processed = await makeExpiryJob().process();
        expect(processed).toBe(0);

        // Critically, it must NOT have cleared the window -- that field is
        // ProcessTournamentAttendance's to resolve.
        const [row] = await postgres.query<Array<{ ends_at: string | null }>>(
          `SELECT individual_check_in_ends_at AS ends_at FROM tournaments WHERE id = $1`,
          [t.id],
        );
        expect(row.ends_at).not.toBeNull();
        expect(await tfx.tournamentStatus(t.id)).toBe("RegistrationOpen");
      });

      it("ignores an automatic-flow Solo Random window (still RegistrationOpen), leaving it for the attendance scheduler", async () => {
        const t = await tfx.createTournament(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
          "Wingman",
        );
        await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
        await postgres.query(
          "UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)",
          [t.id],
        );
        await postgres.query(
          `UPDATE tournaments
           SET start = now() + interval '15 minutes',
               individual_check_in_ends_at = now() - interval '1 minute',
               individual_check_in_duration_minutes = 45
           WHERE id = $1`,
          [t.id],
        );

        const player = await fx.player();
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
           VALUES ($1, $2)`,
          [t.id, player],
        );

        const processed = await makeExpiryJob().process();
        expect(processed).toBe(0);

        // The un-checked-in player must NOT have been Removed, and no second
        // window may have been opened -- that reopen loop is manual-flow only.
        const [signup] = await postgres.query<Array<{ status: string }>>(
          `SELECT status FROM tournament_individual_signups WHERE tournament_id = $1`,
          [t.id],
        );
        expect(signup.status).toBe("Registered");
      });

      it("still processes a manual Solo Random window (RegistrationClosed), preserving existing organizer behavior", async () => {
        const t = await tfx.createTournament(
          [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }],
          "Wingman",
        );
        await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
        await postgres.query(
          "UPDATE match_options SET individual_registration_enabled = true WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)",
          [t.id],
        );
        const player = await fx.player();
        await postgres.query(
          `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
           VALUES ($1, $2)`,
          [t.id, player],
        );
        await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
        await postgres.query(
          `UPDATE tournaments
           SET individual_check_in_ends_at = now() - interval '1 minute',
               individual_check_in_duration_minutes = 5
           WHERE id = $1`,
          [t.id],
        );

        const processed = await makeExpiryJob().process();
        expect(processed).toBe(1);

        const [signup] = await postgres.query<Array<{ status: string }>>(
          `SELECT status FROM tournament_individual_signups WHERE tournament_id = $1`,
          [t.id],
        );
        expect(signup.status).toBe("Removed");
      });
    });

    it("does not act twice on the same tournament: a manual close racing the scheduler leaves exactly one outcome", async () => {
      const t = await tfx.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 2 }],
        "Wingman",
      );
      await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
      await postgres.query(
        `UPDATE tournaments
         SET start = now() + interval '10 minutes',
             individual_check_in_ends_at = now() - interval '1 minute'
         WHERE id = $1`,
        [t.id],
      );

      // Simulate a manual close that already landed before the scheduler's
      // transaction runs.
      await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");

      const job = makeJob();
      const result = await job.process();

      // The scheduler's own SELECT only picks up status = 'RegistrationOpen'
      // tournaments, so an already-closed tournament is never even attempted.
      expect(result.finalized).toBe(0);
      expect(await tfx.tournamentStatus(t.id)).toBe("RegistrationClosed");
    });
  });
});
