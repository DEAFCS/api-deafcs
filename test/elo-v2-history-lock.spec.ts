import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// DEAFCS ELO v2 (every rated 5v5 match) and the ELO history lock, against the
// real ELO engine: the formula pieces, activation leaving every rating as it
// is, which formula a match keeps, the database guards on locked history, and
// the recompute after the boundary (void, chronological rebuild, idempotent,
// never replaying or rewriting the locked period).
describe("ELO v2 + history lock (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EloV2HistoryLockTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199540000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // The lock table is append-only by design; tests reset it as the owner,
  // with its guard trigger off for that one statement.
  const unlock = async () => {
    await postgres.query(
      "ALTER TABLE elo_history_locks DISABLE TRIGGER tbud_elo_history_locks_append_only",
    );
    await postgres.query("DELETE FROM elo_history_locks");
    await postgres.query(
      "ALTER TABLE elo_history_locks ENABLE TRIGGER tbud_elo_history_locks_append_only",
    );
  };

  beforeEach(async () => {
    await unlock();
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'public.seasons_enabled'",
    );
  });

  type Row = {
    steam_id: string;
    current: number;
    change: number;
    impact: number | null;
    expected_score: number;
    performance_multiplier: number;
    series_multiplier: number;
    elo_version: number;
    scale_factor: number | null;
  };
  const rows = async (matchId: string): Promise<Record<string, Row>> =>
    Object.fromEntries(
      (
        await postgres.query<Array<Row>>(
          `SELECT steam_id::text, current::int, change::int, impact::float8,
                  expected_score::float8, performance_multiplier::float8,
                  series_multiplier::int, elo_version::int, scale_factor
             FROM player_elo WHERE match_id = $1`,
          [matchId],
        )
      ).map((r) => [String(r.steam_id), r]),
    );
  const generate = (id: string) =>
    postgres.query("SELECT generate_player_elo_for_match($1)", [id]);
  const activate = () =>
    postgres.query("SELECT activate_elo_v2('test activation')");
  const allElo = () =>
    postgres.query<
      Array<{
        steam_id: string;
        match_id: string;
        current: number;
        change: number;
      }>
    >(
      `SELECT steam_id::text, match_id, current::int, change::int
         FROM player_elo ORDER BY match_id, steam_id`,
    );

  // A 5v5 (Competitive) or 1v1 (Duel) match with explicit lineups. `at` is
  // its end time as SQL (e.g. "now() - interval '3 days'"); `startedAt`
  // optionally starts it earlier, which is when its formula is stamped.
  const played = async ({
    type = "Competitive",
    one,
    two,
    winner = "one",
    at,
    startedAt,
  }: {
    type?: "Competitive" | "Duel" | "Wingman";
    one: string[];
    two: string[];
    winner?: "one" | "two";
    at: string;
    startedAt?: string;
  }) => {
    const match = await fx.match({ type, bestOf: 1 });
    for (const steam of one) await fx.lineupPlayer(match.lineup_1_id, steam);
    for (const steam of two) await fx.lineupPlayer(match.lineup_2_id, steam);
    if (startedAt) {
      await postgres.query(
        `UPDATE matches SET started_at = ${startedAt} WHERE id = $1`,
        [match.id],
      );
    }
    // Two statements, like the other ELO suites: setting the winner lets
    // tbu_matches stamp ended_at = now(), so the end time is set after it.
    await postgres.query(
      `UPDATE matches
          SET winning_lineup_id = ${winner === "one" ? "lineup_1_id" : "lineup_2_id"}
        WHERE id = $1`,
      [match.id],
    );
    await postgres.query(`UPDATE matches SET ended_at = ${at} WHERE id = $1`, [
      match.id,
    ]);
    return match;
  };

  // Stats that make the view rate the player: one map, `rounds` rounds.
  const stats = async (
    matchId: string,
    steam: string,
    s: {
      kills: number;
      deaths: number;
      assists: number;
      damage: number;
      kast: number;
      rounds: number;
    },
  ) => {
    let [map] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order" LIMIT 1`,
      [matchId],
    );
    if (!map) {
      [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [matchId],
      );
    }
    await postgres.query(
      `INSERT INTO player_match_map_stats
         (steam_id, match_map_id, match_id, kills, deaths, assists, damage,
          rounds_played, kast_rounds, kast_total_rounds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8)`,
      [
        steam,
        map.id,
        matchId,
        s.kills,
        s.deaths,
        s.assists,
        s.damage,
        s.rounds,
        s.kast,
      ],
    );
    const [rating] = await postgres.query<Array<{ hltv_rating: number }>>(
      `SELECT hltv_rating::float8 FROM v_player_match_rating WHERE match_id = $1 AND steam_id = $2`,
      [matchId, steam],
    );
    return Number(rating.hltv_rating);
  };

  describe("formula", () => {
    it("expected score uses the given scale: 10,000 for v2, 4,000 for version 1", async () => {
      const [r] = await postgres.query<
        Array<{ v2: number; v1: number; even: number }>
      >(
        `SELECT elo_expected_score(5000, 6000, 10000)::float8 AS v2,
                elo_expected_score(5000, 6000, 4000)::float8 AS v1,
                elo_expected_score(5000, 5000, 10000)::float8 AS even`,
      );
      expect(r.v2).toBeCloseTo(1 / (1 + Math.pow(10, 1000 / 10000)), 12);
      expect(r.v1).toBeCloseTo(1 / (1 + Math.pow(10, 1000 / 4000)), 12);
      expect(r.even).toBe(0.5);
    });

    it.each([
      [0.4, 0.75, 1.25],
      [0.5, 0.75, 1.25],
      [0.75, 0.875, 1.125],
      [1.0, 1.0, 1.0],
      [1.25, 1.125, 0.875],
      [1.5, 1.25, 0.75],
      [1.6, 1.25, 0.75],
      [null, 1.0, 1.0],
    ])(
      "HLTV %s gives win PERF %s and loss PERF %s",
      async (hltv, win, loss) => {
        const [r] = await postgres.query<Array<{ win: number; loss: number }>>(
          `SELECT elo_v2_performance_multiplier($1, true)::float8 AS win,
                elo_v2_performance_multiplier($1, false)::float8 AS loss`,
          [hltv],
        );
        expect(r.win).toBeCloseTo(win, 12);
        expect(r.loss).toBeCloseTo(loss, 12);
      },
    );
  });

  describe("before activation nothing changes", () => {
    it("a 5v5 match still uses version 1 (scale 4,000) and nothing is locked", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      const m = await played({ one, two, at: "now() - interval '1 day'" });
      await generate(m.id);
      for (const row of Object.values(await rows(m.id))) {
        expect(row.elo_version).toBe(1);
        expect(row.scale_factor).toBe(4000);
      }
      const [lock] = await postgres.query<Array<{ locked: string | null }>>(
        "SELECT elo_history_locked_before()::text AS locked",
      );
      expect(lock.locked).toBeNull();
    });
  });

  describe("activation", () => {
    it("keeps every current rating exactly as it is and locks it", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      const first = await played({ one, two, at: "now() - interval '3 days'" });
      const second = await played({
        one,
        two,
        winner: "two",
        at: "now() - interval '2 days'",
      });
      await generate(first.id);
      await generate(second.id);
      const before = await allElo();

      await activate();

      expect(await allElo()).toEqual(before);
      const [lock] = await postgres.query<Array<{ formula_version: number }>>(
        "SELECT formula_version FROM elo_history_locks",
      );
      expect(lock.formula_version).toBe(2);
    });

    it("refuses a second activation, a boundary in the future, and a rated match still waiting for its ELO", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      await played({ one, two, at: "now() - interval '2 hours'" });
      await expect(activate()).rejects.toThrow(/without ELO yet/);

      await postgres.query("DELETE FROM matches");
      await activate();
      await expect(activate()).rejects.toThrow(/already active/);
      await expect(
        postgres.query(
          "SELECT lock_elo_history('later', 2::smallint, NULL, now() + interval '1 day')",
        ),
      ).rejects.toThrow(/in the future/);
    });
  });

  describe("which formula a match uses", () => {
    it("rates a 5v5 match started after activation with v2 (scale 10,000, PERF from the HLTV-style rating)", async () => {
      await activate();
      const one = await fx.players(5);
      const two = await fx.players(5);
      const m = await played({ one, two, at: "now() + interval '1 hour'" });
      const strong = await stats(m.id, one[0], {
        kills: 30,
        deaths: 10,
        assists: 5,
        damage: 3000,
        kast: 18,
        rounds: 20,
      });
      const weak = await stats(m.id, two[0], {
        kills: 5,
        deaths: 18,
        assists: 1,
        damage: 700,
        kast: 8,
        rounds: 20,
      });
      await generate(m.id);
      const r = await rows(m.id);

      expect(r[one[0]].elo_version).toBe(2);
      expect(r[one[0]].scale_factor).toBe(10000);
      expect(r[one[0]].impact).toBeCloseTo(strong, 6);
      expect(r[one[0]].performance_multiplier).toBeCloseTo(
        Math.min(1.25, Math.max(0.75, 1 + 0.5 * (strong - 1))),
        9,
      );
      expect(r[two[0]].performance_multiplier).toBeCloseTo(
        2 - Math.min(1.25, Math.max(0.75, 1 + 0.5 * (weak - 1))),
        9,
      );
      // Everyone starts at 5,000: expected 0.5, so the winner's change is
      // round(500 * 0.5 * PERF), with PostgreSQL's float ROUND (ties to even,
      // the existing convention), and a player without stats is neutral.
      const [{ rounded }] = await postgres.query<Array<{ rounded: number }>>(
        "SELECT round(500 * 0.5 * $1::float8)::int AS rounded",
        [r[one[0]].performance_multiplier],
      );
      expect(r[one[0]].change).toBe(rounded);
      expect(r[one[1]].impact).toBeNull();
      expect(r[one[1]].performance_multiplier).toBe(1);
      expect(r[one[1]].change).toBe(250);
      expect(r[two[1]].change).toBe(-250);
    });

    it("uses each player's own rating against the opponents' average on uneven teams", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      // Before activation: one[0] wins twice and climbs above 5,000.
      for (const days of [5, 4]) {
        const warm = await played({
          one: [one[0]],
          two: [two[4]],
          type: "Competitive",
          at: `now() - interval '${days} days'`,
        });
        await generate(warm.id);
      }
      await activate();
      const m = await played({
        one,
        two,
        winner: "two",
        at: "now() + interval '1 hour'",
      });
      await generate(m.id);
      const r = await rows(m.id);
      const startOf = (row: Row) => row.current - row.change;

      const loser = r[one[0]];
      const expected =
        1 /
        (1 +
          Math.pow(
            10,
            ((5000 * 4 + startOf(r[two[4]])) / 5 - startOf(loser)) / 10000,
          ));
      expect(loser.expected_score).toBeCloseTo(expected, 9);
      expect(loser.change).toBe(Math.round(500 * (0 - expected) * 1 * 1));
      // A higher-rated loser expected more, so loses more than a 5,000 teammate.
      expect(loser.change).toBeLessThan(r[one[1]].change);
    });

    it("keeps version 1 for a match already underway at activation, even if it finishes afterwards", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      const m = await fx.match({ type: "Competitive", bestOf: 1 });
      for (const s of one) await fx.lineupPlayer(m.lineup_1_id, s);
      for (const s of two) await fx.lineupPlayer(m.lineup_2_id, s);
      await postgres.query(
        "UPDATE matches SET started_at = now() - interval '10 minutes' WHERE id = $1",
        [m.id],
      );

      await activate();
      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [m.id],
      );
      await postgres.query(
        "UPDATE matches SET ended_at = now() + interval '30 minutes' WHERE id = $1",
        [m.id],
      );
      await generate(m.id);

      const [stamp] = await postgres.query<Array<{ elo_version: number }>>(
        "SELECT elo_version FROM matches WHERE id = $1",
        [m.id],
      );
      expect(stamp.elo_version).toBe(1);
      for (const row of Object.values(await rows(m.id))) {
        expect(row.elo_version).toBe(1);
        expect(row.scale_factor).toBe(4000);
      }
    });

    it("gives v2 to a match created before activation that only starts afterwards", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      const m = await fx.match({ type: "Competitive", bestOf: 1 });
      for (const s of one) await fx.lineupPlayer(m.lineup_1_id, s);
      for (const s of two) await fx.lineupPlayer(m.lineup_2_id, s);

      await activate();
      await postgres.query(
        "UPDATE matches SET started_at = now() + interval '1 minute', winning_lineup_id = lineup_1_id WHERE id = $1",
        [m.id],
      );
      await postgres.query(
        "UPDATE matches SET ended_at = now() + interval '40 minutes' WHERE id = $1",
        [m.id],
      );
      await generate(m.id);
      for (const row of Object.values(await rows(m.id))) {
        expect(row.elo_version).toBe(2);
      }
      // The stamp is final.
      await expect(
        postgres.query("UPDATE matches SET elo_version = 1 WHERE id = $1", [
          m.id,
        ]),
      ).rejects.toThrow(/is fixed/);
    });

    it("rates a 5v5 tournament match with v2 too", async () => {
      await activate();
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        4,
        "Competitive",
      );
      const semi = (await tfx.getBrackets(t.stageIds[0])).find(
        (b) => b.round === 1,
      )!;
      await tfx.winMatch(semi.match_id!);
      expect(await generate(semi.match_id!)).toBeTruthy();
      const r = Object.values(await rows(semi.match_id!));
      expect(r.length).toBeGreaterThan(0);
      for (const row of r) {
        expect(row.elo_version).toBe(2);
        expect(row.scale_factor).toBe(10000);
      }
    });

    it("leaves Duel and Wingman on version 1 after activation, with the same result as before", async () => {
      const [a, b] = await fx.players(2);
      const before = await played({
        type: "Duel",
        one: [a],
        two: [b],
        at: "now() - interval '2 days'",
      });
      await generate(before.id);
      const beforeRow = (await rows(before.id))[a];

      await activate();
      const [c, d] = await fx.players(2);
      const after = await played({
        type: "Duel",
        one: [c],
        two: [d],
        at: "now() + interval '1 hour'",
      });
      await generate(after.id);
      const afterRow = (await rows(after.id))[c];
      expect(afterRow.elo_version).toBe(1);
      expect(afterRow.scale_factor).toBe(4000);
      expect(afterRow.change).toBe(beforeRow.change);
      expect(afterRow.performance_multiplier).toBeCloseTo(
        beforeRow.performance_multiplier,
        12,
      );

      const [e, f, g, h] = await fx.players(4);
      const wing = await played({
        type: "Wingman",
        one: [e, f],
        two: [g, h],
        at: "now() + interval '2 hours'",
      });
      await generate(wing.id);
      expect((await rows(wing.id))[e].elo_version).toBe(1);
    });
  });

  describe("locked history", () => {
    const lockedSetup = async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      const old = await played({ one, two, at: "now() - interval '2 days'" });
      await generate(old.id);
      await activate();
      return { one, two, old };
    };

    it("refuses to update, delete, add or truncate locked rows", async () => {
      const { one, old } = await lockedSetup();
      await expect(
        postgres.query(
          "UPDATE player_elo SET current = current + 1 WHERE match_id = $1",
          [old.id],
        ),
      ).rejects.toThrow(/is locked/);
      await expect(
        postgres.query("DELETE FROM player_elo WHERE match_id = $1", [old.id]),
      ).rejects.toThrow(/is locked/);
      await expect(
        postgres.query(
          `INSERT INTO player_elo (type, match_id, steam_id, current, change, created_at)
           VALUES ('Competitive', $1, $2, 1, 1, now() - interval '5 days')`,
          [old.id, one[0]],
        ),
      ).rejects.toThrow(/is locked/);
      await expect(postgres.query("TRUNCATE TABLE player_elo")).rejects.toThrow(
        /cannot be truncated/,
      );
    });

    it("leaves a locked match exactly as it is when it is calculated again", async () => {
      const { old } = await lockedSetup();
      const before = await rows(old.id);
      expect(await generate(old.id)).toEqual([
        { generate_player_elo_for_match: 0 },
      ]);
      expect(await rows(old.id)).toEqual(before);
    });

    it("refuses to void or delete a locked rated match", async () => {
      const { old } = await lockedSetup();
      await expect(
        postgres.query("UPDATE matches SET elo_voided = true WHERE id = $1", [
          old.id,
        ]),
      ).rejects.toThrow(/locked ELO history/);
      await expect(
        postgres.query("DELETE FROM matches WHERE id = $1", [old.id]),
      ).rejects.toThrow(/locked ELO history/);
    });

    it("still lets a player account be deleted, and a canceled match with a locked no-show penalty", async () => {
      const { one, old } = await lockedSetup();
      const canceled = await fx.match({ type: "Competitive", bestOf: 1 });
      await unlock();
      await postgres.query("SELECT apply_no_show_elo_penalty($1, $2)", [
        canceled.id,
        one[1],
      ]);
      await activate();

      await postgres.query("DELETE FROM matches WHERE id = $1", [canceled.id]);
      await postgres.query(
        "DELETE FROM player_terms_acceptances WHERE player_steam_id = $1",
        [one[0]],
      );
      await postgres.query("DELETE FROM players WHERE steam_id = $1", [one[0]]);
      const left = await rows(old.id);
      expect(left[one[0]]).toBeUndefined();
      expect(Object.keys(left)).toHaveLength(9);
    });

    it("refuses the old full recompute's truncate and the full rebuild", async () => {
      await lockedSetup();
      await expect(
        postgres.query("TRUNCATE TABLE player_elo"),
      ).rejects.toThrow();
    });
  });

  describe("recompute after the boundary", () => {
    it("voiding match A rebuilds match B from the locked baseline, not from 5,000 and not reusing B's old change", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      // Locked history: the first team wins twice before activation.
      for (const days of [4, 3]) {
        const m = await played({
          one,
          two,
          at: `now() - interval '${days} days'`,
        });
        await generate(m.id);
      }
      await activate();
      const baseline = Object.fromEntries(
        (
          await postgres.query<Array<{ steam_id: string; current: number }>>(
            `SELECT DISTINCT ON (steam_id) steam_id::text, current::int
               FROM player_elo ORDER BY steam_id, created_at DESC`,
          )
        ).map((r) => [r.steam_id, r.current]),
      );
      const lockedBefore = await allElo();

      const a = await played({ one, two, at: "now() + interval '1 hour'" });
      const b = await played({ one, two, at: "now() + interval '2 hours'" });
      await generate(a.id);
      await generate(b.id);
      const bBefore = await rows(b.id);
      expect(bBefore[one[0]].current - bBefore[one[0]].change).toBe(
        baseline[one[0]] + (await rows(a.id))[one[0]].change,
      );

      await postgres.query(
        "UPDATE matches SET elo_voided = true WHERE id = $1",
        [a.id],
      );
      const [{ rebuilt }] = await postgres.query<Array<{ rebuilt: number }>>(
        "SELECT recompute_elo_after_lock() AS rebuilt",
      );
      expect(rebuilt).toBe(2);

      const aAfter = await rows(a.id);
      const bAfter = await rows(b.id);
      for (const steam of [...one, ...two]) {
        // A no longer moves anyone; B starts from the locked baseline.
        expect(aAfter[steam].change).toBe(0);
        expect(aAfter[steam].current).toBe(baseline[steam]);
        expect(bAfter[steam].current - bAfter[steam].change).toBe(
          baseline[steam],
        );
      }
      // B's change was recalculated from the new balances (one won both
      // locked matches, so it is no longer an even game for them).
      expect(bAfter[one[0]].change).not.toBe(bBefore[one[0]].change);
      expect(bAfter[one[0]].elo_version).toBe(2);

      // Locked rows untouched; a second run gives identical rows.
      const lockedNow = (await allElo()).filter((r) =>
        lockedBefore.some((l) => l.match_id === r.match_id),
      );
      expect(lockedNow).toEqual(lockedBefore);
      const once = await allElo();
      await postgres.query("SELECT recompute_elo_after_lock()");
      expect(await allElo()).toEqual(once);
    });

    it("keeps a no-show penalty after the boundary and re-bases it on the rebuilt rating", async () => {
      const one = await fx.players(5);
      const two = await fx.players(5);
      // In the past: the no-show penalty reads the rating "before now".
      await postgres.query(
        "SELECT lock_elo_history('test', 2::smallint, NULL, now() - interval '1 day')",
      );
      const a = await played({ one, two, at: "now() - interval '2 hours'" });
      await generate(a.id);
      const canceled = await fx.match({ type: "Competitive", bestOf: 1 });
      await postgres.query(
        "UPDATE matches SET ended_at = now() - interval '1 hour' WHERE id = $1",
        [canceled.id],
      );
      await postgres.query("SELECT apply_no_show_elo_penalty($1, $2)", [
        canceled.id,
        one[0],
      ]);
      const withA = (await rows(a.id))[one[0]].current;
      expect((await rows(canceled.id))[one[0]].current).toBe(withA - 250);

      await postgres.query(
        "UPDATE matches SET elo_voided = true WHERE id = $1",
        [a.id],
      );
      await postgres.query("SELECT recompute_elo_after_lock()");
      expect((await rows(canceled.id))[one[0]]).toMatchObject({
        change: -250,
        current: 5000 - 250,
      });
    });

    it("refuses to run without a lock", async () => {
      await expect(
        postgres.query("SELECT recompute_elo_after_lock()"),
      ).rejects.toThrow(/not locked/);
    });
  });

  // The approved schedule: Season 1 runs until Season 2 starts on 1 January
  // 2027 (seasons.starts_at, already in production). Here Season 1 is
  // [now - 20 days, now - 1 day), ELO v2 was activated 10 days ago, and
  // Season 2 starts 1 day ago. Its seasons row is inserted after Season 1's
  // matches, which is how the clock reaching 1 January looks to the database.
  describe("Season 2 transition", () => {
    const ts = async (sql: string) =>
      (
        await postgres.query<Array<{ t: string }>>(`SELECT (${sql})::text AS t`)
      )[0].t;
    const startOf = async (steam: string, matchId: string) => {
      const [row] = await postgres.query<
        Array<{ start: number; season_id: string; elo_version: number }>
      >(
        `SELECT (current - change)::int AS start, season_id, elo_version
           FROM player_elo WHERE match_id = $1 AND steam_id = $2`,
        [matchId, steam],
      );
      return row;
    };
    const startSeason2 = async () =>
      fx.season(await ts("now() - interval '1 day'"));
    const season2Id = async () =>
      (
        await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM seasons ORDER BY starts_at DESC LIMIT 1",
        )
      )[0].id;

    const setup = async () => {
      await fx.enableSeasons();
      await fx.season(
        await ts("now() - interval '20 days'"),
        await ts("now() - interval '1 day'"),
      );
      const one = await fx.players(5);
      const two = await fx.players(5);
      const [d1, d2] = await fx.players(2);
      // Season 1, before v2 (version 1).
      const old5 = await played({ one, two, at: "now() - interval '15 days'" });
      const oldDuel = await played({
        type: "Duel",
        one: [d1],
        two: [d2],
        at: "now() - interval '15 days'",
      });
      await generate(old5.id);
      await generate(oldDuel.id);
      await postgres.query(
        "SELECT lock_elo_history('test v2 activation', 2::smallint, NULL, now() - interval '10 days')",
      );
      // Season 1, after v2.
      const s1v2 = await played({
        one,
        two,
        at: "now() - interval '5 days'",
        startedAt: "now() - interval '5 days 1 hour'",
      });
      const s1Duel = await played({
        type: "Duel",
        one: [d1],
        two: [d2],
        at: "now() - interval '5 days'",
      });
      await generate(s1v2.id);
      await generate(s1Duel.id);
      return { one, two, d1, d2, old5, s1v2 };
    };

    it("activating v2 during Season 1 keeps every rating; Season 1 v2 matches continue from it", async () => {
      const { one, old5, s1v2 } = await setup();
      const after = await startOf(one[0], s1v2.id);
      expect(after.start).toBe((await rows(old5.id))[one[0]].current);
      expect(after.elo_version).toBe(2);
    });

    it("Season 2's start locks all of Season 1 automatically; every mode starts at 5,000 (v2 for 5v5, version 1 for Duel and Wingman)", async () => {
      const { one, two, d1, d2, s1v2 } = await setup();
      const season1 = await allElo();
      await startSeason2();
      const [{ same }] = await postgres.query<Array<{ same: boolean }>>(
        "SELECT elo_history_locked_before() = (SELECT max(starts_at) FROM seasons) AS same",
      );
      expect(same).toBe(true);

      // Season 1 after v2 is permanent now too.
      await expect(
        postgres.query(
          "UPDATE player_elo SET current = current + 1 WHERE match_id = $1",
          [s1v2.id],
        ),
      ).rejects.toThrow(/is locked/);
      await expect(
        postgres.query("UPDATE matches SET elo_voided = true WHERE id = $1", [
          s1v2.id,
        ]),
      ).rejects.toThrow(/locked ELO history/);
      expect(await generate(s1v2.id)).toEqual([
        { generate_player_elo_for_match: 0 },
      ]);

      const s2 = await played({ one, two, at: "now() - interval '12 hours'" });
      const s2Duel = await played({
        type: "Duel",
        one: [d1],
        two: [d2],
        at: "now() - interval '12 hours'",
      });
      const wing = await fx.players(4);
      const s2Wing = await played({
        type: "Wingman",
        one: wing.slice(0, 2),
        two: wing.slice(2),
        at: "now() - interval '11 hours'",
      });
      await generate(s2.id);
      await generate(s2Duel.id);
      await generate(s2Wing.id);

      const season2 = await season2Id();
      for (const steam of [...one, ...two]) {
        expect(await startOf(steam, s2.id)).toEqual({
          start: 5000,
          season_id: season2,
          elo_version: 2,
        });
      }
      for (const steam of [d1, d2]) {
        expect(await startOf(steam, s2Duel.id)).toEqual({
          start: 5000,
          season_id: season2,
          elo_version: 1,
        });
      }
      expect((await startOf(wing[0], s2Wing.id)).elo_version).toBe(1);
      const kept = (await allElo()).filter((r) =>
        season1.some((b) => b.match_id === r.match_id),
      );
      expect(kept).toEqual(season1);
    });

    it("Void and Recalculate in Season 2 rebuild Season 2 only, never Season 1 or pre-v2 history", async () => {
      const { one, two } = await setup();
      const season1 = await allElo();
      await startSeason2();
      const a = await played({ one, two, at: "now() - interval '12 hours'" });
      const b = await played({
        one,
        two,
        winner: "two",
        at: "now() - interval '6 hours'",
      });
      await generate(a.id);
      await generate(b.id);

      await postgres.query(
        "UPDATE matches SET elo_voided = true WHERE id = $1",
        [a.id],
      );
      const [{ rebuilt }] = await postgres.query<Array<{ rebuilt: number }>>(
        "SELECT recompute_elo_after_lock() AS rebuilt",
      );
      expect(rebuilt).toBe(2);
      for (const steam of [...one, ...two]) {
        expect((await rows(a.id))[steam].change).toBe(0);
        expect((await startOf(steam, b.id)).start).toBe(5000);
      }
      const kept = (await allElo()).filter((r) =>
        season1.some((s) => s.match_id === r.match_id),
      );
      expect(kept).toEqual(season1);
      const once = await allElo();
      await postgres.query("SELECT recompute_elo_after_lock()");
      expect(await allElo()).toEqual(once);
    });

    it("a match started in Season 1 and finished after midnight counts for Season 2: v2, from 5,000", async () => {
      const { one, two } = await setup();
      const across = await fx.match({ type: "Competitive", bestOf: 1 });
      for (const steam of one) await fx.lineupPlayer(across.lineup_1_id, steam);
      for (const steam of two) await fx.lineupPlayer(across.lineup_2_id, steam);
      await postgres.query(
        "UPDATE matches SET started_at = now() - interval '1 day 30 minutes' WHERE id = $1",
        [across.id],
      );
      await startSeason2();
      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
        [across.id],
      );
      await postgres.query(
        "UPDATE matches SET ended_at = now() - interval '23 hours 20 minutes' WHERE id = $1",
        [across.id],
      );
      await generate(across.id);
      const season2 = await season2Id();
      for (const steam of [...one, ...two]) {
        expect(await startOf(steam, across.id)).toEqual({
          start: 5000,
          season_id: season2,
          elo_version: 2,
        });
      }
    });

    it("a Season 1 match whose ELO job runs just after midnight still gets its first rating, then is locked", async () => {
      const { one, two, s1v2 } = await setup();
      const late = await played({
        one,
        two,
        at: "now() - interval '1 day 10 minutes'",
      });
      await startSeason2();

      expect(await generate(late.id)).toEqual([
        { generate_player_elo_for_match: 10 },
      ]);
      const r = await startOf(one[0], late.id);
      expect(r.start).toBe((await rows(s1v2.id))[one[0]].current);
      expect(r.elo_version).toBe(2);
      // That first calculation only: now it is locked like the rest of Season 1.
      const first = await rows(late.id);
      expect(await generate(late.id)).toEqual([
        { generate_player_elo_for_match: 0 },
      ]);
      expect(await rows(late.id)).toEqual(first);
      await expect(
        postgres.query("UPDATE matches SET elo_voided = true WHERE id = $1", [
          late.id,
        ]),
      ).rejects.toThrow(/locked ELO history/);
      // A Season 1 match from earlier that never got ELO is not filled in later.
      const older = await played({ one, two, at: "now() - interval '2 days'" });
      expect(await generate(older.id)).toEqual([
        { generate_player_elo_for_match: 0 },
      ]);
    });

    it("a player who has not played in Season 2 counts as 5,000 there and keeps their Season 1 history", async () => {
      const { two, s1v2 } = await setup();
      const season1Rating = (await rows(s1v2.id))[two[0]].current;
      expect(season1Rating).not.toBe(5000);
      await startSeason2();
      const fresh = await fx.players(5);
      const m = await played({
        one: fresh,
        two,
        at: "now() - interval '2 hours'",
      });
      await generate(m.id);
      const [r] = await postgres.query<
        Array<{ opponent_team_elo_avg: number }>
      >(
        "SELECT opponent_team_elo_avg::float8 FROM player_elo WHERE match_id = $1 AND steam_id = $2",
        [m.id, fresh[0]],
      );
      expect(r.opponent_team_elo_avg).toBe(5000);
      expect((await rows(s1v2.id))[two[0]].current).toBe(season1Rating);
    });
  });
});
