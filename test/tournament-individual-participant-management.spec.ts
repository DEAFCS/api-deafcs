import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Covers the two participant-management actions the Solo Random players list
// needs beyond Add Player:
//
//   checkInTournamentIndividualPlayer - organizer confirms attendance for
//     another player, under the SAME window rule as the player's own
//     check-in (no privileged bypass of the cutoff).
//   removeTournamentIndividualPlayer - one action serving both an organizer
//     removing someone and a player leaving a tournament they joined, so the
//     lifecycle guards cannot drift between the two directions.
//
// Removal is a physical DELETE rather than status = 'Removed'; 'Removed'
// means specifically "did not check in before the window closed" and is
// owned by ProcessTournamentCheckInExpiry. See the action's own comment.
describe("Solo Random participant management (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let controller: TournamentsController;

  const makeController = () => {
    const hasuraStub = {
      query: async (queryObj: any, steamId?: string) => {
        const id = queryObj.tournaments_by_pk.__args.id;
        const rows = await postgres.query<
          Array<{
            id: string;
            is_organizer: boolean;
            status: string;
            individual_check_in_ends_at: Date | null;
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
                  t.individual_check_in_ends_at,
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
                individual_check_in_ends_at: row.individual_check_in_ends_at,
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
      new Logger("IndividualParticipantTest"),
      hasuraStub as never,
      null as never,
      null as never,
      null as never,
      postgres,
      null as never,
      null as never,
      null as never,
      // This suite isn't testing Terms enforcement -- fixture players
      // accept by default (see Fixtures.player), so a stub that always
      // passes keeps this test focused on individual check-in behavior.
      { assertAccepted: async () => {} } as never,
    );
  };

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentIndividualParticipantTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199975000000n);
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

  const createSoloRandom = async ({
    status = "RegistrationOpen",
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
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL) RETURNING id`,
      [fx.nextName("solo"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 4)`,
      [tournament.id],
    );
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

  // Opened AFTER signups on purpose: registering while the window is already
  // open is auto-checked-in by tbi_tournament_individual_signups, which is
  // exactly the case organizer check-in does NOT need to handle. The real
  // pending player signed up first and the window opened around them.
  const openWindow = (tournamentId: string) =>
    postgres.query(
      `UPDATE tournaments SET individual_check_in_ends_at = now() + interval '10 minutes' WHERE id = $1`,
      [tournamentId],
    );

  const user = (steam_id: string) => ({ steam_id, role: "user" }) as never;

  // Signs a player up directly, bypassing the action, so these tests are not
  // coupled to Add Player.
  const signUp = async (
    tournamentId: string,
    steamId: string,
    overrides: { status?: string; checkedIn?: boolean } = {},
  ) => {
    await postgres.query(
      `INSERT INTO tournament_individual_signups (tournament_id, player_steam_id)
       VALUES ($1, $2)`,
      [tournamentId, steamId],
    );
    if (overrides.status) {
      await postgres.query(
        `UPDATE tournament_individual_signups SET status = $3
         WHERE tournament_id = $1 AND player_steam_id = $2`,
        [tournamentId, steamId, overrides.status],
      );
    }
    if (overrides.checkedIn) {
      await postgres.query(
        `UPDATE tournament_individual_signups SET checked_in_at = now()
         WHERE tournament_id = $1 AND player_steam_id = $2`,
        [tournamentId, steamId],
      );
    }
  };

  const signupOf = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; checked_in_at: Date | null }>
    >(
      `SELECT status, checked_in_at FROM tournament_individual_signups
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row ?? null;
  };

  const checkIn = (tournamentId: string, actor: string, target: string) =>
    controller.checkInTournamentIndividualPlayer({
      user: user(actor),
      tournament_id: tournamentId,
      player_steam_id: target,
    });

  const remove = (tournamentId: string, actor: string, target: string) =>
    controller.removeTournamentIndividualPlayer({
      user: user(actor),
      tournament_id: tournamentId,
      player_steam_id: target,
    });

  // --- organizer check-in ---------------------------------------------------

  describe("checkInTournamentIndividualPlayer", () => {
    it("organizer checks in a Registered player during the window", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player);
      await openWindow(t.id);

      const result = await checkIn(t.id, t.organizer, player);
      expect(result.success).toBe(true);
      expect(result.already_checked_in).toBe(false);

      const signup = await signupOf(t.id, player);
      expect(signup!.checked_in_at).not.toBeNull();
    });

    it("a co-organizer can too, reusing the existing organizer check", async () => {
      const t = await createSoloRandom();
      const coOrganizer = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)`,
        [t.id, coOrganizer],
      );
      const player = await fx.player();
      await signUp(t.id, player);
      await openWindow(t.id);

      await expect(checkIn(t.id, coOrganizer, player)).resolves.toMatchObject({
        success: true,
      });
      expect((await signupOf(t.id, player))!.checked_in_at).not.toBeNull();
    });

    it("an ordinary player cannot check in someone else", async () => {
      const t = await createSoloRandom();
      const stranger = await fx.player();
      const player = await fx.player();
      await signUp(t.id, player);
      await openWindow(t.id);

      await expect(checkIn(t.id, stranger, player)).rejects.toThrow(
        /not the tournament organizer/i,
      );
      expect((await signupOf(t.id, player))!.checked_in_at).toBeNull();
    });

    it("checks in a Waitlisted player too -- they can still qualify", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { status: "Waitlisted" });
      await openWindow(t.id);

      const result = await checkIn(t.id, t.organizer, player);
      expect(result.status).toBe("Waitlisted");
      expect((await signupOf(t.id, player))!.checked_in_at).not.toBeNull();
    });

    it("rejects before the attendance window opens", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(checkIn(t.id, t.organizer, player)).rejects.toThrow(
        /check-in is not currently open/i,
      );
    });

    it("rejects once the window has closed -- no organizer bypass of the cutoff", async () => {
      const t = await createSoloRandom();
      await postgres.query(
        `UPDATE tournaments SET individual_check_in_ends_at = now() - interval '1 minute' WHERE id = $1`,
        [t.id],
      );
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(checkIn(t.id, t.organizer, player)).rejects.toThrow(
        /check-in is not currently open/i,
      );
      expect((await signupOf(t.id, player))!.checked_in_at).toBeNull();
    });

    it("rejects a player who is not signed up", async () => {
      const t = await createSoloRandom();
      const stranger = await fx.player();
      await openWindow(t.id);

      await expect(checkIn(t.id, t.organizer, stranger)).rejects.toThrow(
        /not signed up/i,
      );
    });

    it("rejects a non-individual tournament", async () => {
      const t = await createSoloRandom({ individual: false });
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(checkIn(t.id, t.organizer, player)).rejects.toThrow(
        /individual registration is not enabled/i,
      );
    });

    it("is idempotent for an already checked-in player", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { checkedIn: true });
      await openWindow(t.id);
      const before = (await signupOf(t.id, player))!.checked_in_at;

      const result = await checkIn(t.id, t.organizer, player);
      expect(result.success).toBe(true);
      expect(result.already_checked_in).toBe(true);
      // The original timestamp is preserved, not refreshed.
      expect((await signupOf(t.id, player))!.checked_in_at).toEqual(before);
    });

    it("rejects an invalid steam id", async () => {
      const t = await createSoloRandom();
      await expect(checkIn(t.id, t.organizer, "nope")).rejects.toThrow(
        /invalid player steam id/i,
      );
    });
  });

  // --- organizer removal ----------------------------------------------------

  describe("removeTournamentIndividualPlayer (organizer)", () => {
    it("organizer removes a Registered player", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player);

      const result = await remove(t.id, t.organizer, player);
      expect(result.success).toBe(true);
      expect(result.was_self).toBe(false);
      expect(await signupOf(t.id, player)).toBeNull();
    });

    it("organizer removes a Waitlisted player", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { status: "Waitlisted" });

      await expect(remove(t.id, t.organizer, player)).resolves.toMatchObject({
        success: true,
      });
      expect(await signupOf(t.id, player)).toBeNull();
    });

    it("removal is a DELETE, never a 'Removed' no-show marker", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player);

      await remove(t.id, t.organizer, player);

      const [{ count }] = await postgres.query<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM tournament_individual_signups
          WHERE tournament_id = $1 AND status = 'Removed'`,
        [t.id],
      );
      expect(count).toBe(0);
    });

    it("frees the capacity slot so the next signup lands Registered", async () => {
      // 4-team Wingman stage caps at 8 Registered.
      const t = await createSoloRandom();
      const players: Array<string> = [];
      for (let i = 0; i < 8; i++) {
        const p = await fx.player();
        players.push(p);
        await signUp(t.id, p);
      }
      // Capacity full: the 9th overflows.
      const overflow = await fx.player();
      await signUp(t.id, overflow);
      expect((await signupOf(t.id, overflow))!.status).toBe("Waitlisted");

      await remove(t.id, t.organizer, players[0]);

      // With a slot freed, a fresh signup is Registered again -- the existing
      // capacity trigger, not custom promotion logic.
      const next = await fx.player();
      await signUp(t.id, next);
      expect((await signupOf(t.id, next))!.status).toBe("Registered");
    });

    it("rejects a non-organizer acting on someone else", async () => {
      const t = await createSoloRandom();
      const stranger = await fx.player();
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(remove(t.id, stranger, player)).rejects.toThrow(
        /not authorized/i,
      );
      expect(await signupOf(t.id, player)).not.toBeNull();
    });

    it("rejects once registration has closed (cutoff passed)", async () => {
      const t = await createSoloRandom({ status: "RegistrationClosed" });
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(remove(t.id, t.organizer, player)).rejects.toThrow(
        /registration is closed/i,
      );
      expect(await signupOf(t.id, player)).not.toBeNull();
    });

    it("rejects an Assigned participant", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { status: "Assigned" });

      await expect(remove(t.id, t.organizer, player)).rejects.toThrow(
        /already been assigned/i,
      );
    });

    it("rejects a non-individual tournament", async () => {
      const t = await createSoloRandom({ individual: false });
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(remove(t.id, t.organizer, player)).rejects.toThrow(
        /individual registration is not enabled/i,
      );
    });

    it("rejects a player who is not signed up", async () => {
      const t = await createSoloRandom();
      const stranger = await fx.player();

      await expect(remove(t.id, t.organizer, stranger)).rejects.toThrow(
        /not signed up/i,
      );
    });
  });

  // --- self leave -----------------------------------------------------------

  describe("removeTournamentIndividualPlayer (self leave)", () => {
    it("a player leaves their own Registered signup", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player);

      const result = await remove(t.id, player, player);
      expect(result.success).toBe(true);
      expect(result.was_self).toBe(true);
      expect(await signupOf(t.id, player)).toBeNull();
    });

    it("a player leaves after already checking in", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { checkedIn: true });

      await expect(remove(t.id, player, player)).resolves.toMatchObject({
        was_self: true,
      });
      expect(await signupOf(t.id, player)).toBeNull();
    });

    it("a waitlisted player can leave too", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { status: "Waitlisted" });

      await expect(remove(t.id, player, player)).resolves.toMatchObject({
        success: true,
      });
      expect(await signupOf(t.id, player)).toBeNull();
    });

    it("a player cannot leave on someone else's behalf", async () => {
      const t = await createSoloRandom();
      const a = await fx.player();
      const b = await fx.player();
      await signUp(t.id, a);
      await signUp(t.id, b);

      await expect(remove(t.id, a, b)).rejects.toThrow(/not authorized/i);
      expect(await signupOf(t.id, b)).not.toBeNull();
    });

    it("cannot leave after the cutoff", async () => {
      const t = await createSoloRandom({ status: "RegistrationClosed" });
      const player = await fx.player();
      await signUp(t.id, player);

      await expect(remove(t.id, player, player)).rejects.toThrow(
        /registration is closed/i,
      );
      expect(await signupOf(t.id, player)).not.toBeNull();
    });

    it("cannot leave once assigned to a generated team", async () => {
      const t = await createSoloRandom();
      const player = await fx.player();
      await signUp(t.id, player, { status: "Assigned" });

      await expect(remove(t.id, player, player)).rejects.toThrow(
        /already been assigned/i,
      );
    });
  });
});
