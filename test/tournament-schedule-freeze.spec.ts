import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Once tournament attendance check-in has opened, the three columns that
// define that window are frozen:
//
//   start
//   attendance_check_in_open_before_minutes
//   attendance_check_in_close_before_minutes
//
// Live testing changed the timing mid-window and produced confusing state: the
// scheduler and the already-registered participants were still acting on the
// previous window. The UI now disables the fields, but the Hasura update
// permission exposes all three to any organizer, so the real control is
// tbu_tournaments.
//
// Applies to team and Solo Random tournaments alike -- this is about
// attendance, not registration type.
describe("tournament attendance schedule freeze (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentScheduleFreezeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199973000000n);
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

  // startOffsetMinutes controls where "now" sits relative to the window:
  // with the default 60-minute open offset, a start 61 minutes out means
  // check-in has NOT opened; 59 minutes out means it has.
  const createTournament = async ({
    startOffsetMinutes,
    individual = false,
    openBefore = 60,
    closeBefore = 15,
  }: {
    startOffsetMinutes: number;
    individual?: boolean;
    openBefore?: number;
    closeBefore?: number;
  }) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, individual_registration_enabled)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [individual],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
         (name, start, organizer_steam_id, match_options_id, status,
          attendance_check_in_open_before_minutes,
          attendance_check_in_close_before_minutes)
       VALUES ($1, now() + ($2 || ' minutes')::interval, $3, $4, 'RegistrationOpen', $5, $6)
       RETURNING id`,
      [
        fx.nextName("cup"),
        startOffsetMinutes,
        organizer,
        options.id,
        openBefore,
        closeBefore,
      ],
    );
    return { id: tournament.id, organizer };
  };

  const started = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ started: boolean }>>(
      `SELECT tournament_attendance_started(t) AS started
         FROM tournaments t WHERE t.id = $1`,
      [tournamentId],
    );
    return row.started;
  };

  const setStart = (tournamentId: string, organizer: string, offset: string) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query(
        `UPDATE tournaments SET start = now() + ($2)::interval WHERE id = $1`,
        [tournamentId, offset],
      ),
    );

  const setOpenBefore = (
    tournamentId: string,
    organizer: string,
    value: number,
  ) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query(
        `UPDATE tournaments SET attendance_check_in_open_before_minutes = $2 WHERE id = $1`,
        [tournamentId, value],
      ),
    );

  const setCloseBefore = (
    tournamentId: string,
    organizer: string,
    value: number,
  ) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query(
        `UPDATE tournaments SET attendance_check_in_close_before_minutes = $2 WHERE id = $1`,
        [tournamentId, value],
      ),
    );

  describe("before check-in opens", () => {
    it("attendance has not started", async () => {
      const t = await createTournament({ startOffsetMinutes: 120 });
      expect(await started(t.id)).toBe(false);
    });

    it("start is editable", async () => {
      const t = await createTournament({ startOffsetMinutes: 120 });
      await expect(setStart(t.id, t.organizer, "180 minutes")).resolves.toBeDefined();
    });

    it("both offsets are editable", async () => {
      const t = await createTournament({ startOffsetMinutes: 120 });
      await expect(setOpenBefore(t.id, t.organizer, 90)).resolves.toBeDefined();
      await expect(setCloseBefore(t.id, t.organizer, 20)).resolves.toBeDefined();
    });
  });

  describe("once check-in has opened", () => {
    it("attendance has started", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      expect(await started(t.id)).toBe(true);
    });

    it("rejects changing only the start", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(setStart(t.id, t.organizer, "45 minutes")).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    it("rejects changing only the open-before offset", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(setOpenBefore(t.id, t.organizer, 90)).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    it("rejects changing only the close-before offset", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(setCloseBefore(t.id, t.organizer, 5)).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    it("rejects changing several schedule fields together", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(
        runAsUser(postgres, t.organizer, "admin", (query) =>
          query(
            `UPDATE tournaments
                SET start = now() + interval '300 minutes',
                    attendance_check_in_open_before_minutes = 90,
                    attendance_check_in_close_before_minutes = 5
              WHERE id = $1`,
            [t.id],
          ),
        ),
      ).rejects.toThrow(/cannot be changed after check-in has started/i);
    });

    // The bypass the guard exists for: decide from OLD, never from the
    // proposed value, or moving the start forward would recompute the window
    // into the future and unfreeze it in the same statement.
    it("rejects moving the start far into the future to escape the lock", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(
        setStart(t.id, t.organizer, "10 days"),
      ).rejects.toThrow(/cannot be changed after check-in has started/i);
      // And it really did not move.
      expect(await started(t.id)).toBe(true);
    });

    it("still allows unrelated settings to be edited", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(
        runAsUser(postgres, t.organizer, "admin", (query) =>
          query(`UPDATE tournaments SET name = $2 WHERE id = $1`, [
            t.id,
            "renamed cup",
          ]),
        ),
      ).resolves.toBeDefined();
    });

    // Status transitions must keep working -- the scheduler drives them.
    it("still allows the status transition the scheduler performs", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(
        runAsUser(postgres, t.organizer, "admin", (query) =>
          query(
            `UPDATE tournaments SET status = 'RegistrationClosed' WHERE id = $1`,
            [t.id],
          ),
        ),
      ).resolves.toBeDefined();
    });

    // And the scheduler's own attendance write is unaffected.
    it("still allows individual_check_in_ends_at to be written", async () => {
      const t = await createTournament({ startOffsetMinutes: 30 });
      await expect(
        postgres.query(
          `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
          [t.id],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("applies regardless of registration type", () => {
    it("freezes a normal team tournament", async () => {
      const t = await createTournament({
        startOffsetMinutes: 30,
        individual: false,
      });
      await expect(setStart(t.id, t.organizer, "45 minutes")).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    it("freezes a Solo Random tournament", async () => {
      const t = await createTournament({
        startOffsetMinutes: 30,
        individual: true,
      });
      await expect(setStart(t.id, t.organizer, "45 minutes")).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });
  });

  describe("the lock is one-way", () => {
    // Window long past: still frozen, not editable again.
    it("stays frozen after the window has closed", async () => {
      const t = await createTournament({ startOffsetMinutes: -120 });
      expect(await started(t.id)).toBe(true);
      await expect(setOpenBefore(t.id, t.organizer, 90)).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    // The backend stamp alone freezes it, even if the derived time has not
    // been reached (e.g. an organizer opened check-in manually).
    it("is frozen by the scheduler's stamp alone", async () => {
      const t = await createTournament({ startOffsetMinutes: 600 });
      expect(await started(t.id)).toBe(false);
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
        [t.id],
      );
      expect(await started(t.id)).toBe(true);
      await expect(setStart(t.id, t.organizer, "700 minutes")).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });
  });

  describe("boundary", () => {
    // 19:00 start, 60-minute open offset -> opens 18:00. Just before that,
    // editable; at/after it, locked.
    it("editable one minute before the window opens", async () => {
      const t = await createTournament({ startOffsetMinutes: 61 });
      expect(await started(t.id)).toBe(false);
      await expect(setOpenBefore(t.id, t.organizer, 45)).resolves.toBeDefined();
    });

    it("locked one minute after the window opens", async () => {
      const t = await createTournament({ startOffsetMinutes: 59 });
      expect(await started(t.id)).toBe(true);
      await expect(setOpenBefore(t.id, t.organizer, 45)).rejects.toThrow(
        /cannot be changed after check-in has started/i,
      );
    });

    // The offset itself moves the boundary: a 30-minute open offset on a
    // 45-minute-out start has not opened yet.
    it("honours a custom open-before offset", async () => {
      const t = await createTournament({
        startOffsetMinutes: 45,
        openBefore: 30,
      });
      expect(await started(t.id)).toBe(false);
    });
  });
});
