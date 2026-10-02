import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Admin "Void ELO" (matches.elo_voided) against the real ELO engine:
// the voided match keeps its per-player player_elo rows and metrics with a
// 0 change at the pre-match rating, the next match starts from that
// unchanged rating, a full chronological rebuild keeps it voided, and the
// void itself leaves the match's result untouched.
describe("ELO void (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EloVoidTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199510000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await postgres.query("DELETE FROM settings WHERE name = 'public.seasons_enabled'");
  });

  // A finished 1v1 (Duel), A or B winning, ended N days ago.
  const duel = async (a: string, b: string, winner: "a" | "b", endedDaysAgo: number) => {
    const match = await fx.match({ type: "Duel", bestOf: 1 });
    await fx.lineupPlayer(match.lineup_1_id, a);
    await fx.lineupPlayer(match.lineup_2_id, b);
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = ${winner === "a" ? "lineup_1_id" : "lineup_2_id"} WHERE id = $1`,
      [match.id],
    );
    await postgres.query(
      `UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1`,
      [match.id, endedDaysAgo],
    );
    return match;
  };
  const generate = (id: string) =>
    postgres.query("SELECT generate_player_elo_for_match($1)", [id]);
  // Exactly the update voidMatchElo runs.
  const voidElo = (id: string, admin: string) =>
    postgres.query(
      `UPDATE matches
          SET elo_voided = true, elo_voided_at = now(), elo_voided_by = $2
        WHERE id = $1 AND elo_voided = false
        RETURNING id`,
      [id, admin],
    );
  type Row = {
    steam_id: string;
    current: number;
    change: number;
    impact: number | null;
    actual_score: number | null;
    expected_score: number | null;
    kills: number | null;
    deaths: number | null;
    kda: number | null;
    map_wins: number | null;
  };
  const rows = async (matchId: string) =>
    Object.fromEntries(
      (
        await postgres.query<Array<Row>>(
          `SELECT steam_id::text, current::int, change::int, impact::float8,
                  actual_score::float8, expected_score::float8,
                  kills::int, deaths::int, kda::float8, map_wins::int
             FROM player_elo WHERE match_id = $1`,
          [matchId],
        )
      ).map((r) => [String(r.steam_id), r]),
    );

  it("the void only flips the flag: status, winner and end time are untouched", async () => {
    const [a, b] = await fx.players(2);
    const admin = await fx.player();
    const match = await duel(a, b, "a", 2);
    const [before] = await postgres.query<any[]>(
      "SELECT status, winning_lineup_id, ended_at, elo_voided FROM matches WHERE id = $1",
      [match.id],
    );
    expect(before.status).toBe("Finished");
    expect(before.elo_voided).toBe(false);

    expect(await voidElo(match.id, admin)).toHaveLength(1);
    // Idempotent at the SQL level too.
    expect(await voidElo(match.id, admin)).toHaveLength(0);

    const [after] = await postgres.query<any[]>(
      "SELECT status, winning_lineup_id, ended_at, elo_voided, elo_voided_at, elo_voided_by::text FROM matches WHERE id = $1",
      [match.id],
    );
    expect(after.status).toBe(before.status);
    expect(after.winning_lineup_id).toBe(before.winning_lineup_id);
    expect(new Date(after.ended_at).getTime()).toBe(new Date(before.ended_at).getTime());
    expect(after.elo_voided).toBe(true);
    expect(after.elo_voided_at).not.toBeNull();
    expect(after.elo_voided_by).toBe(admin);
  });

  it("a voided match keeps its rows and metrics with change 0 at the pre-match rating; the next match starts from it", async () => {
    const [a, b] = await fx.players(2);
    const admin = await fx.player();
    const first = await duel(a, b, "a", 3);
    const cheated = await duel(a, b, "a", 2);
    const next = await duel(a, b, "b", 1);

    await generate(first.id);
    const afterFirst = await rows(first.id);
    expect(afterFirst[a].change).toBeGreaterThan(0);

    await voidElo(cheated.id, admin);
    await generate(cheated.id);
    const voided = await rows(cheated.id);
    for (const player of [a, b]) {
      // Still in the history, with its normal metrics...
      expect(voided[player]).toBeDefined();
      expect(voided[player].impact).not.toBeNull();
      expect(voided[player].expected_score).not.toBeNull();
      expect(voided[player].kills).not.toBeNull();
      expect(voided[player].kda).not.toBeNull();
      expect(voided[player].map_wins).not.toBeNull();
      // ...but no rating effect: current is the rating going in.
      expect(voided[player].change).toBe(0);
      expect(voided[player].current).toBe(afterFirst[player].current);
    }
    // The result itself is still represented (A won).
    expect(voided[a].actual_score).toBe(1);
    expect(voided[b].actual_score).toBe(0);

    await generate(next.id);
    const afterNext = await rows(next.id);
    for (const player of [a, b]) {
      expect(afterNext[player].current - afterNext[player].change).toBe(afterFirst[player].current);
    }
  });

  it("a full chronological rebuild keeps the match voided", async () => {
    const [a, b] = await fx.players(2);
    const admin = await fx.player();
    const first = await duel(a, b, "a", 3);
    const cheated = await duel(a, b, "a", 2);
    const next = await duel(a, b, "b", 1);
    await voidElo(cheated.id, admin);

    // What PlayerEloRecomputeService.runRecomputeAll does.
    await postgres.query("TRUNCATE TABLE player_elo");
    const ids = await postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM matches
        WHERE ended_at IS NOT NULL AND winning_lineup_id IS NOT NULL
        ORDER BY created_at ASC, id ASC`,
    );
    expect(ids.map((r) => r.id)).toEqual([first.id, cheated.id, next.id]);
    for (const { id } of ids) await generate(id);

    const r1 = await rows(first.id);
    const r2 = await rows(cheated.id);
    const r3 = await rows(next.id);
    for (const player of [a, b]) {
      expect(r2[player].change).toBe(0);
      expect(r2[player].current).toBe(r1[player].current);
      expect(r3[player].current - r3[player].change).toBe(r1[player].current);
    }
  });

  it("an un-voided match is rated exactly as before", async () => {
    const [a, b] = await fx.players(2);
    const match = await duel(a, b, "a", 1);
    await generate(match.id);
    const r = await rows(match.id);
    expect(r[a].change).toBeGreaterThan(0);
    expect(r[b].change).toBeLessThan(0);
    expect(r[a].current).toBe(5000 + r[a].change);
  });

  it("a voided match that is otherwise unrated stays without player_elo rows", async () => {
    const [a, b] = await fx.players(2);
    const admin = await fx.player();
    const imported = await duel(a, b, "a", 1);
    await postgres.query("UPDATE matches SET source = 'faceit' WHERE id = $1", [imported.id]);
    await voidElo(imported.id, admin);
    await generate(imported.id);
    expect(Object.keys(await rows(imported.id))).toHaveLength(0);
  });
});
