import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Covers addTournamentIndividualPlayer: the organizer/admin path for putting
// an existing DEAFCS player into a Solo Random individual sign-up pool.
//
// The point of the action is that it is NOT a parallel signup pipeline -- it
// validates, then performs the same plain INSERT a self-signup does, so the
// capacity cap, the waitlist, created_at priority and the late-signup
// auto-check-in all come from tbi_tournament_individual_signups exactly as
// they would for the player themselves. These tests assert that equivalence,
// plus the authorization/eligibility gates that self-signup got from its
// Hasura insert permission and that this action has to enforce itself.
describe("organizer adds a Solo Random player (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let controller: TournamentsController;

  // Stands in for HasuraService.query. The action makes exactly one Hasura
  // call (the tournament lookup, run under the acting user's session), so the
  // stub resolves it with the same SQL Hasura's permissions would --
  // including is_tournament_organizer(), which is a real database function.
  const makeController = () => {
    const hasuraStub = {
      query: async (queryObj: any, steamId?: string) => {
        const id = queryObj.tournaments_by_pk.__args.id;
        const rows = await postgres.query<
          Array<{
            id: string;
            is_organizer: boolean;
            status: string;
            individual_registration_enabled: boolean;
          }>
        >(
          `SELECT t.id,
                  is_tournament_organizer(
                      t,
                      json_build_object('x-hasura-role', 'user',
                                        'x-hasura-user-id', $2::text)
                  ) AS is_organizer,
                  t.status,
                  mo.individual_registration_enabled
             FROM tournaments t
             JOIN match_options mo ON mo.id = t.match_options_id
            WHERE t.id = $1`,
          [id, steamId ?? null],
        );
        const row = rows.at(0);
        return {
          tournaments_by_pk: row
            ? {
                id: row.id,
                is_organizer: row.is_organizer,
                status: row.status,
                options: {
                  individual_registration_enabled:
                    row.individual_registration_enabled,
                },
              }
            : null,
        };
      },
    };

    return new TournamentsController(
      new Logger("AddIndividualPlayerTest"),
      hasuraStub as never,
      null as never,
      null as never,
      null as never,
      postgres,
      null as never,
      null as never,
      null as never,
      { assertAccepted: async () => {} } as never,
    );
  };

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentAddIndividualPlayerTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199977000000n);
    controller = makeController();
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

  // A Solo Random (individual registration) Wingman tournament with a
  // first stage sized to `maxTeams`, so the capacity cap is
  // maxTeams * min_players_per_lineup -- 8 players at the 4-team minimum a
  // stage is allowed to declare.
  const createSoloRandom = async ({
    maxTeams = 4,
    status = "RegistrationOpen",
    minRole = null as string | null,
    individual = true,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, individual_registration_enabled)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [individual],
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
          (name, start, organizer_steam_id, match_options_id, status, min_role)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', $4) RETURNING id`,
      [fx.nextName("solo"), organizer, options.id, minRole],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, $2)`,
      [tournament.id, maxTeams],
    );
    // Status transitions are validated (can_close_tournament_registration
    // only accepts RegistrationOpen), so walk rather than jump.
    for (const step of ["RegistrationOpen", status]) {
      if (step === "Setup") continue;
      await postgres.query(`UPDATE tournaments SET status = $2 WHERE id = $1`, [
        tournament.id,
        step,
      ]);
      if (step === status) break;
    }
    return { id: tournament.id, organizer };
  };

  const user = (steam_id: string, role = "user") =>
    ({ steam_id, role }) as never;

  const add = (tournamentId: string, actor: string, playerSteamId: string) =>
    controller.addTournamentIndividualPlayer({
      user: user(actor),
      tournament_id: tournamentId,
      player_steam_id: playerSteamId,
    });

  const signupsOf = (tournamentId: string) =>
    postgres.query<
      Array<{
        player_steam_id: string;
        status: string;
        checked_in_at: Date | null;
        created_at: Date;
      }>
    >(
      `SELECT player_steam_id, status, checked_in_at, created_at
         FROM tournament_individual_signups
        WHERE tournament_id = $1
        ORDER BY created_at`,
      [tournamentId],
    );

  describe("authorization", () => {
    it("lets the tournament organizer add an eligible player", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();

      const result = await add(t.id, t.organizer, player);
      expect(result.success).toBe(true);
      expect(result.status).toBe("Registered");

      const signups = await signupsOf(t.id);
      expect(signups).toHaveLength(1);
      expect(signups[0].player_steam_id).toBe(player);
    });

    it("rejects a non-organizer", async () => {
      const t = await createSoloRandom();
      const stranger = await fx.player();
      const player = await fx.player();

      await expect(add(t.id, stranger, player)).rejects.toThrow(
        /not the tournament organizer/i,
      );
      expect(await signupsOf(t.id)).toHaveLength(0);
    });

    it("accepts a co-organizer, reusing the existing organizer check", async () => {
      const t = await createSoloRandom();
      const coOrganizer = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)`,
        [t.id, coOrganizer],
      );
      const player = await fx.player();

      await expect(add(t.id, coOrganizer, player)).resolves.toMatchObject({
        success: true,
      });
    });
  });

  describe("input and tournament-state validation", () => {
    it("rejects a player that does not exist", async () => {
      const t = await createSoloRandom();

      await expect(add(t.id, t.organizer, "76561199000000001")).rejects.toThrow(
        /player not found/i,
      );
    });

    it("rejects a non-numeric steam id without touching the database", async () => {
      const t = await createSoloRandom();

      await expect(add(t.id, t.organizer, "not-a-steam-id")).rejects.toThrow(
        /invalid player steam id/i,
      );
    });

    it("rejects a tournament that is not individual-registration", async () => {
      const t = await createSoloRandom({ individual: false });
      const player = await fx.player();

      await expect(add(t.id, t.organizer, player)).rejects.toThrow(
        /individual registration is not enabled/i,
      );
    });

    it("rejects once registration has closed", async () => {
      const t = await createSoloRandom({ status: "RegistrationClosed" });
      const player = await fx.player();

      await expect(add(t.id, t.organizer, player)).rejects.toThrow(
        /registration is not open/i,
      );
    });

    it("rejects a duplicate signup", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();

      await add(t.id, t.organizer, player);
      await expect(add(t.id, t.organizer, player)).rejects.toThrow(
        /already signed up/i,
      );
      expect(await signupsOf(t.id)).toHaveLength(1);
    });

    it("rejects a player who is already waitlisted", async () => {
      const t = await createSoloRandom();
      // Wingman min lineup is 2, so a 4-team stage caps at 8 Registered.
      for (let i = 0; i < 8; i++) {
        await add(t.id, t.organizer, await fx.player());
      }
      const overflow = await fx.player();
      const waitlisted = await add(t.id, t.organizer, overflow);
      expect(waitlisted.status).toBe("Waitlisted");

      await expect(add(t.id, t.organizer, overflow)).rejects.toThrow(
        /already signed up/i,
      );
    });
  });

  describe("minimum role", () => {
    it("rejects a player below the tournament's minimum role", async () => {
      const t = await createSoloRandom({ minRole: "verified_user" });
      const player = await fx.player(); // default role: user

      await expect(add(t.id, t.organizer, player)).rejects.toThrow(
        /minimum role/i,
      );
      expect(await signupsOf(t.id)).toHaveLength(0);
    });

    it("accepts a player at or above the tournament's minimum role", async () => {
      const t = await createSoloRandom({ minRole: "verified_user" });
      const player = await fx.player();
      await postgres.query(
        `UPDATE players SET role = 'verified_user' WHERE steam_id = $1`,
        [player],
      );

      await expect(add(t.id, t.organizer, player)).resolves.toMatchObject({
        success: true,
      });
    });

    it("is evaluated against the TARGET player, not the acting organizer", async () => {
      const t = await createSoloRandom({ minRole: "verified_user" });
      // Organizer is a plain user; the eligible target still goes through.
      const player = await fx.player();
      await postgres.query(
        `UPDATE players SET role = 'verified_user' WHERE steam_id = $1`,
        [player],
      );

      await expect(add(t.id, t.organizer, player)).resolves.toMatchObject({
        success: true,
      });
    });
  });

  describe("attendance check-in", () => {
    it("added before the check-in window opens: checked_in_at stays NULL", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();

      const result = await add(t.id, t.organizer, player);
      expect(result.checked_in).toBe(false);

      const [signup] = await signupsOf(t.id);
      expect(signup.checked_in_at).toBeNull();
    });

    it("added during an open check-in window: auto-checked-in by the same trigger a self-signup uses", async () => {
      const t = await createSoloRandom();
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
        [t.id],
      );
      const player = await fx.player();

      const result = await add(t.id, t.organizer, player);
      expect(result.checked_in).toBe(true);

      const [signup] = await signupsOf(t.id);
      expect(signup.checked_in_at).not.toBeNull();
    });

    it("an expired check-in window does not auto-check-in", async () => {
      const t = await createSoloRandom();
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() - interval '1 minute' WHERE id = $1`,
        [t.id],
      );
      const player = await fx.player();

      const result = await add(t.id, t.organizer, player);
      expect(result.checked_in).toBe(false);
    });
  });

  describe("capacity and waitlist", () => {
    // Wingman: min_players_per_lineup = 2, so a 4-team stage caps at 8.
    it("overflows onto the waitlist at capacity, exactly like a self-signup", async () => {
      const t = await createSoloRandom();

      const statuses: Array<string> = [];
      for (let i = 0; i < 10; i++) {
        const result = await add(t.id, t.organizer, await fx.player());
        statuses.push(result.status);
      }

      expect(statuses).toEqual([
        ...Array(8).fill("Registered"),
        "Waitlisted",
        "Waitlisted",
      ]);
    });

    it("does not bypass the cap even for the organizer", async () => {
      const t = await createSoloRandom();
      for (let i = 0; i < 8; i++) {
        await add(t.id, t.organizer, await fx.player());
      }

      const [{ registered }] = await postgres.query<
        Array<{ registered: number }>
      >(
        `SELECT COUNT(*)::int AS registered FROM tournament_individual_signups
          WHERE tournament_id = $1 AND status = 'Registered'`,
        [t.id],
      );
      expect(registered).toBe(8);

      const extra = await add(t.id, t.organizer, await fx.player());
      expect(extra.status).toBe("Waitlisted");
    });
  });

  describe("registration priority", () => {
    it("takes created_at from when the player was added -- no organizer backdating", async () => {
      const t = await createSoloRandom();
      const before = Date.now();
      const first = await fx.player();
      const second = await fx.player();

      await add(t.id, t.organizer, first);
      await add(t.id, t.organizer, second);

      const signups = await signupsOf(t.id);
      expect(signups.map((s) => s.player_steam_id)).toEqual([first, second]);
      for (const signup of signups) {
        expect(signup.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(signup.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      }
    });

    it("gives an organizer-added player no priority over an earlier self-signup", async () => {
      const t = await createSoloRandom();
      const selfSignup = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
         VALUES ($1, $2)`,
        [t.id, selfSignup],
      );

      const added = await fx.player();
      await add(t.id, t.organizer, added);

      const signups = await signupsOf(t.id);
      expect(signups.map((s) => s.player_steam_id)).toEqual([
        selfSignup,
        added,
      ]);
    });
  });
});
