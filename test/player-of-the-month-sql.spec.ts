import { PostgresService } from "./../src/postgres/postgres.service";
import { PlayerOfTheMonthService } from "./../src/awards/player-of-the-month/player-of-the-month.service";
import { PlayerOfTheMonthController } from "./../src/awards/player-of-the-month/player-of-the-month.controller";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// Player of the Month against the migrated schema (migration
// 1891100000100_player_of_the_month): candidates from real match rows,
// staff approval creating exactly one award per month, rejection, the
// 12-month rule from real award history, and the append-only audit trail.
describe("Player of the Month (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: PlayerOfTheMonthService;
  let admin: string;

  // A finished month well in the past so every month here is reviewable.
  const MONTH = "2026-08";
  const IN_MONTH = "2026-08-15T18:00:00Z";

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerOfTheMonthTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199730000000n);
    await seedRegionWithServer(postgres, "TestA");
    service = new PlayerOfTheMonthService(postgres);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Review rows are append-only/restricted by design; tests clean them as
    // the table owner, bypassing the audit trigger.
    await postgres.query("ALTER TABLE player_of_the_month_review_events DISABLE TRIGGER USER");
    await postgres.query("DELETE FROM player_of_the_month_review_events");
    await postgres.query("ALTER TABLE player_of_the_month_review_events ENABLE TRIGGER USER");
    await postgres.query("DELETE FROM player_of_the_month_reviews");
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    admin = await fx.player();
  });

  async function finished(type: string, a: string, b: string, endedAt = IN_MONTH, rounds = 13) {
    const match = await fx.match({ type, mapVeto: true });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    for (let r = 1; r <= rounds; r++) await fx.round(map.id, r, { l1Score: r, l2Score: 0 });
    await postgres.query(`UPDATE matches SET status = 'Finished', winning_lineup_id = lineup_1_id WHERE id = $1`, [match.id]);
    await postgres.query(`UPDATE matches SET ended_at = $2 WHERE id = $1`, [match.id, endedAt]);
    return match.id;
  }

  it("the migration adds the system award", async () => {
    const [award] = await postgres.query<Array<{ tier: string; allow_multiple: boolean }>>(
      `SELECT tier, allow_multiple FROM awards WHERE system_key = 'player_of_the_month'`,
    );
    expect(award).toEqual({ tier: "special", allow_multiple: true });
  });

  it("ranks by eligible matches across modes; other months and custom matches do not count", async () => {
    const [a, b, c] = await fx.players(3);
    await finished("Competitive", a, b);
    await finished("Wingman", a, c);
    await finished("Duel", a, b);
    await finished("Duel", b, c);
    await finished("Competitive", c, b, "2026-09-02T10:00:00Z"); // next month
    const custom = await finished("Duel", c, b);
    await postgres.query(`UPDATE matches SET organizer_steam_id = $2 WHERE id = $1`, [custom, admin]);

    const snap = await service.calculateSnapshot(MONTH);
    expect(snap.recommendedSteamId).toBe(a);
    const byId = Object.fromEntries(snap.candidates.map((x) => [x.steamId, x]));
    expect(byId[a]).toMatchObject({ eligibleMatches: 3, roundsPlayed: 39, byType: { Competitive: 1, Wingman: 1, Duel: 1 } });
    expect(byId[c].eligibleMatches).toBe(2);
    expect(byId[c].notCounted.custom).toBe(1);
    expect(byId[a].name).toEqual(expect.any(String));
  });

  it("a staff ban during the month disqualifies; the player is still listed with the reason", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, remove_sanction_date, sanctioned_by_steam_id)
       VALUES ($1, 'ban', 'test', '2026-08-20T00:00:00Z', '2026-08-25T00:00:00Z', $2)`,
      [a, admin],
    );
    const snap = await service.calculateSnapshot(MONTH);
    const ca = snap.candidates.find((x) => x.steamId === a)!;
    expect(ca.eligible).toBe(false);
    expect(ca.disqualifiedBy[0]).toMatch(/^ban/);
  });

  it("a Steam VAC ban (automatic sanction, VAC flag) does not disqualify", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    // Exactly what steam-bans.service.ts writes: a ban with no staff member.
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason, created_at)
       VALUES ($1, 'ban', NULL, 'Auto: Steam VAC ban', '2026-08-05T00:00:00Z')`,
      [a],
    );
    await postgres.query(`UPDATE players SET vac_banned = true, vac_ban_count = 1, game_ban_count = 2 WHERE steam_id = $1`, [a]);
    const snap = await service.calculateSnapshot(MONTH);
    const ca = snap.candidates.find((x) => x.steamId === a)!;
    expect(ca.eligible).toBe(true);
    expect(ca.vac).toEqual({ banned: true, vacBanCount: 1, gameBanCount: 2 });
    expect(ca.sanctions.map((x) => x.effect)).toEqual(["info"]);
    expect(snap.recommendedSteamId).toBe(a);
  });

  it("calculate -> approve creates exactly one manual award occurrence in the player's history", async () => {
    const [a, b] = await fx.players(2);
    await finished("Competitive", a, b);
    await finished("Competitive", a, b);

    const pending = await service.calculate(MONTH, admin);
    expect(pending.status).toBe("pending");
    // Recalculating is idempotent: same candidates.
    const again = await service.calculate(MONTH, admin);
    expect(again.candidates).toEqual(pending.candidates);

    const winner = pending.candidates.recommendedSteamId!;
    const approved = await service.approve(MONTH, winner, "Great month", admin);
    expect(approved).toMatchObject({ status: "approved", winner_steam_id: winner });
    expect(approved.events.map((e) => e.action)).toEqual(["calculated", "calculated", "approved"]);

    const awards = await postgres.query<Array<{ source: string; calculation_key: string; effective_at: Date; player: string }>>(
      `SELECT o.source, o.calculation_key, o.effective_at, r.player_steam_id::text AS player
         FROM award_occurrences o JOIN award_recipients r ON r.occurrence_id = o.id`,
    );
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({ source: "manual", calculation_key: `player_of_the_month:${MONTH}`, player: winner });
    expect(new Date(awards[0].effective_at).toISOString()).toBe("2026-08-01T00:00:00.000Z");

    // Approved is final: no second approval, no recalculation.
    await expect(service.approve(MONTH, winner, null, admin)).rejects.toThrow(/already approved/);
    await expect(service.calculate(MONTH, admin)).rejects.toThrow(/already approved/);
  });

  it("two concurrent approvals award the month once", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    const review = await service.calculate(MONTH, admin);
    const ids = review.candidates.candidates.filter((c) => c.eligible).map((c) => c.steamId);
    const results = await Promise.allSettled([
      service.approve(MONTH, ids[0], null, admin),
      service.approve(MONTH, ids[1] ?? ids[0], null, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [{ count }] = await postgres.query<Array<{ count: string }>>(`SELECT count(*) FROM award_occurrences`);
    expect(Number(count)).toBe(1);
  });

  it("cannot approve an ineligible or unknown player", async () => {
    const [a, b, outsider] = await fx.players(3);
    await finished("Duel", a, b);
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, sanctioned_by_steam_id) VALUES ($1, 'warning', 'test', '2026-08-10T00:00:00Z', $2)`,
      [a, admin],
    );
    await service.calculate(MONTH, admin);
    await expect(service.approve(MONTH, a, null, admin)).rejects.toThrow(/Not eligible/);
    await expect(service.approve(MONTH, outsider, null, admin)).rejects.toThrow(/Not a candidate/);
    const [{ count }] = await postgres.query<Array<{ count: string }>>(`SELECT count(*) FROM award_occurrences`);
    expect(Number(count)).toBe(0);
  });

  // Approval rechecks the chosen player on current data, inside its
  // transaction: anything that made them ineligible after the last
  // calculation refuses the award, and the month stays pending.
  async function expectRefusedAndPending(winner: string, reason: RegExp) {
    await expect(service.approve(MONTH, winner, null, admin)).rejects.toThrow(reason);
    const [{ count }] = await postgres.query<Array<{ count: string }>>(`SELECT count(*) FROM award_occurrences`);
    expect(Number(count)).toBe(0);
    expect((await service.getReview(MONTH))!.status).toBe("pending");
  }

  it("a staff ban covering the month recorded after the calculation refuses the approval", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    const review = await service.calculate(MONTH, admin);
    expect(review.candidates.candidates.find((c) => c.steamId === a)!.eligible).toBe(true);
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, sanctioned_by_steam_id)
       VALUES ($1, 'ban', 'found later', '2026-08-20T00:00:00Z', $2)`,
      [a, admin],
    );
    await expectRefusedAndPending(a, /No longer eligible: ban 2026-08-20/);
    // The other candidate is unaffected.
    await expect(service.approve(MONTH, b, null, admin)).resolves.toMatchObject({ status: "approved", winner_steam_id: b });
  });

  it("a staff warning issued in the month recorded after the calculation refuses the approval", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, sanctioned_by_steam_id)
       VALUES ($1, 'warning', 'late report', '2026-08-28T00:00:00Z', $2)`,
      [a, admin],
    );
    await expectRefusedAndPending(a, /No longer eligible: warning 2026-08-28/);
  });

  it("a win of an earlier month approved after the calculation refuses the approval (12-month rule)", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b, "2026-07-10T12:00:00Z");
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin); // a eligible for August
    await service.calculate("2026-07", admin);
    await service.approve("2026-07", a, null, admin); // then wins July
    await expect(service.approve(MONTH, a, null, admin)).rejects.toThrow(/No longer eligible: won 2026-07 \(12-month rule\)/);
    expect((await service.getReview(MONTH))!.status).toBe("pending");
  });

  it("matches that stopped counting after the calculation refuse the approval", async () => {
    const [a, b] = await fx.players(2);
    const m = await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    await postgres.query(`UPDATE matches SET elo_voided = true WHERE id = $1`, [m]);
    await expectRefusedAndPending(a, /No longer eligible: no counted match in the month/);
  });

  it("a Steam VAC ban recorded after the calculation does not block the award", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    await postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, reason, created_at)
       VALUES ($1, 'ban', NULL, 'Auto: Steam VAC ban', '2026-08-25T00:00:00Z')`,
      [a],
    );
    await expect(service.approve(MONTH, a, null, admin)).resolves.toMatchObject({ status: "approved", winner_steam_id: a });
  });

  it("race: a ban being written while the approval runs is seen; the approval waits for it and refuses", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);

    let approval: Promise<unknown> | undefined;
    let settled = false;
    await postgres.transaction(async (client) => {
      // A moderator's sanction, inserted but not yet committed.
      await client.query(
        `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, sanctioned_by_steam_id)
         VALUES ($1, 'ban', 'in flight', '2026-08-30T00:00:00Z', $2)`,
        [a, admin],
      );
      approval = service.approve(MONTH, a, null, admin);
      approval.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // Blocked on the player's row lock until the sanction commits.
      expect(settled).toBe(false);
    });
    await expect(approval).rejects.toThrow(/No longer eligible: ban 2026-08-30/);
    const [{ count }] = await postgres.query<Array<{ count: string }>>(`SELECT count(*) FROM award_occurrences`);
    expect(Number(count)).toBe(0);
  });

  it("race: an approval that commits first is not undone by a sanction written during it", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    // The approval holds the player's lock; a sanction insert waits for it.
    const approval = service.approve(MONTH, a, null, admin);
    const sanction = postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, reason, created_at, sanctioned_by_steam_id)
       VALUES ($1, 'warning', 'after', now(), $2)`,
      [a, admin],
    );
    await expect(approval).resolves.toMatchObject({ status: "approved", winner_steam_id: a });
    await sanction;
    const [{ count }] = await postgres.query<Array<{ count: string }>>(`SELECT count(*) FROM award_occurrences`);
    expect(Number(count)).toBe(1);
  });

  it("reject needs a reason; a rejected month can be recalculated back to pending", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    await expect(service.reject(MONTH, " ", admin)).rejects.toThrow(/reason/);
    const rejected = await service.reject(MONTH, "Suspicious activity", admin);
    expect(rejected).toMatchObject({ status: "rejected", decision_note: "Suspicious activity" });
    const recalculated = await service.calculate(MONTH, admin);
    expect(recalculated.status).toBe("pending");
    expect(recalculated.events.map((e) => e.action)).toEqual(["calculated", "rejected", "calculated"]);
  });

  it("a winner of the previous 12 award months is not eligible (real award history)", async () => {
    const [a, b] = await fx.players(2);
    await finished("Duel", a, b, "2026-07-10T12:00:00Z");
    await service.calculate("2026-07", admin);
    await service.approve("2026-07", a, null, admin);

    await finished("Duel", a, b);
    await finished("Duel", a, b);
    const snap = await service.calculateSnapshot(MONTH);
    const ca = snap.candidates.find((x) => x.steamId === a)!;
    expect(ca.eligible).toBe(false);
    expect(ca.disqualifiedBy.join()).toContain("12-month rule");
    expect(snap.recommendedSteamId).toBe(b);
  });

  it("only finished months; the audit trail cannot be edited or deleted", async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await expect(service.calculate(current, admin)).rejects.toThrow(/finished months/);
    await expect(service.calculate("2026-8", admin)).rejects.toThrow(/YYYY-MM/);

    const [a, b] = await fx.players(2);
    await finished("Duel", a, b);
    await service.calculate(MONTH, admin);
    await expect(postgres.query(`DELETE FROM player_of_the_month_review_events`)).rejects.toThrow(/append-only/);
    await expect(postgres.query(`UPDATE player_of_the_month_review_events SET action = 'approved'`)).rejects.toThrow(/append-only/);
  });

  it("actions are administrators only", async () => {
    const controller = new PlayerOfTheMonthController(service);
    const user = (role: string) => ({ steam_id: admin, role, name: "x" }) as any;
    await expect(controller.calculatePlayerOfTheMonth({ month: MONTH, user: user("moderator") })).rejects.toThrow(/administrators/);
    await expect(controller.approvePlayerOfTheMonth({ month: MONTH, player_steam_id: admin, user: undefined })).rejects.toThrow(/administrators/);
    await expect(controller.playerOfTheMonthReview({ month: MONTH, user: user("tournament_organizer") })).rejects.toThrow(/administrators/);
    expect(await controller.playerOfTheMonthReview({ month: MONTH, user: user("administrator") })).toBeNull();
  });
});
