import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

// match_elo_participants: a seated substitute who never plays gets no ELO.
// Activity filter adapted from 5Stack (MIT), scoped in DEAFCS to lineups that
// seat more than the starting lineup, so matchmaking ELO never changes.
describe("ELO participants with seated substitutes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EloSubstitutesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
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

  type Lineups = { one: string[]; two: string[] };

  // A finished match with the given seats; returns ids plus a map for events.
  const finishedMatch = async (
    type: "Wingman" | "Competitive",
    substitutes: number,
    seats: Lineups,
    winner: "one" | "two" = "one",
  ) => {
    const match = await fx.match({ type, substitutes });
    for (const steam of seats.one) await fx.lineupPlayer(match.lineup_1_id, steam);
    for (const steam of seats.two) await fx.lineupPlayer(match.lineup_2_id, steam);
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [match.id],
    );
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = ${winner === "one" ? "lineup_1_id" : "lineup_2_id"},
              ended_at = now() - interval '1 hour' WHERE id = $1`,
      [match.id],
    );
    return { ...match, ctx: { matchId: match.id, mapId: map.id } };
  };

  const generate = async (matchId: string) => {
    const [row] = await postgres.query<Array<{ generate_player_elo_for_match: number }>>(
      "SELECT generate_player_elo_for_match($1)",
      [matchId],
    );
    return Number(row.generate_player_elo_for_match);
  };

  const rated = async (matchId: string) =>
    (
      await postgres.query<Array<{ steam_id: string; change: number }>>(
        "SELECT steam_id, change FROM player_elo WHERE match_id = $1 ORDER BY steam_id",
        [matchId],
      )
    ).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.steam_id]: Number(row.change) }), {});

  // Everyone listed trades a kill with someone on the other side.
  const play = async (ctx: { matchId: string; mapId: string }, one: string[], two: string[]) => {
    for (let i = 0; i < Math.max(one.length, two.length); i++) {
      await fx.kill(ctx, one[i % one.length], two[i % two.length]);
    }
  };

  it("rates active players and skips a seated substitute who never played", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(m.ctx, [a, b], [c, d]);

    expect(await generate(m.id)).toBe(4);
    const rows = await rated(m.id);
    expect(Object.keys(rows).sort()).toEqual([a, b, c, d].sort());
    expect(rows[sub]).toBeUndefined();
  });

  it("an idle substitute does not shift the team average", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    // Give the substitute a very high prior rating: if it counted, A/B's
    // expected score (and so their change) would differ from the control.
    const prior = await finishedMatch("Wingman", 1, { one: [sub], two: [] });
    await postgres.query(
      `INSERT INTO player_elo ("type", match_id, steam_id, current, change, created_at)
       VALUES ('Wingman', $1, $2, 9000, 0, now() - interval '2 days')`,
      [prior.id, sub],
    );

    const withSub = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(withSub.ctx, [a, b], [c, d]);
    await generate(withSub.id);

    const [a2, b2, c2, d2] = await fx.players(4);
    const control = await finishedMatch("Wingman", 1, { one: [a2, b2], two: [c2, d2] });
    await play(control.ctx, [a2, b2], [c2, d2]);
    await generate(control.id);

    const withRows = await rated(withSub.id);
    const controlRows = await rated(control.id);
    expect(withRows[a]).toBe(controlRows[a2]);
    expect(withRows[c]).toBe(controlRows[c2]);
  });

  it("a substitute who plays in a later match is rated for that match", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const first = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(first.ctx, [a, b], [c, d]);
    await generate(first.id);
    expect((await rated(first.id))[sub]).toBeUndefined();

    const later = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(later.ctx, [a, sub], [c, d]);
    await generate(later.id);
    const rows = await rated(later.id);
    expect(rows[sub]).toBeDefined();
    // b sat this one out.
    expect(rows[b]).toBeUndefined();
  });

  it("a substitute swapped in mid-match is rated alongside the starter they replaced", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(m.ctx, [a, b, sub], [c, d]);
    await generate(m.id);
    expect(Object.keys(await rated(m.id)).sort()).toEqual([a, b, sub, c, d].sort());
  });

  it("an active player who abandoned still takes the flat leaver penalty", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(m.ctx, [a, b], [c, d]);
    await postgres.query(
      "UPDATE match_lineup_players SET elo_penalty = true WHERE match_lineup_id = $1 AND steam_id = $2",
      [m.lineup_1_id, b],
    );
    await generate(m.id);
    const rows = await rated(m.id);
    expect(rows[b]).toBe(-250);
    expect(rows[sub]).toBeUndefined();
  });

  it("a flagged leaver with no recorded activity is still penalised", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    await play(m.ctx, [a], [c, d]);
    await postgres.query(
      "UPDATE match_lineup_players SET elo_penalty = true WHERE match_lineup_id = $1 AND steam_id = $2",
      [m.lineup_1_id, b],
    );
    await generate(m.id);
    const rows = await rated(m.id);
    expect(rows[b]).toBe(-250);
    expect(rows[sub]).toBeUndefined();
  });

  it("no recorded activity at all (forfeit / no-show): every seated member keeps the previous behavior", async () => {
    const [a, b, sub, c, d] = await fx.players(5);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, sub], two: [c, d] });
    expect(await generate(m.id)).toBe(5);
  });

  it("one side forfeits without activity: that whole lineup is rated, the active side only its players", async () => {
    const [a, b, subA, c, d, subC] = await fx.players(6);
    const m = await finishedMatch("Wingman", 1, { one: [a, b, subA], two: [c, d, subC] });
    // Only lineup one recorded anything (a teamkill), lineup two never showed.
    await fx.kill(m.ctx, a, b);
    await generate(m.id);
    const rows = await rated(m.id);
    expect(rows[a]).toBeDefined();
    expect(rows[b]).toBeDefined();
    expect(rows[subA]).toBeUndefined();
    for (const steam of [c, d, subC]) expect(rows[steam]).toBeDefined();
  });

  describe("normal matchmaking is unchanged", () => {
    it("a lineup at the starting size rates everyone, even a player with no recorded events", async () => {
      const [a, b, c, d] = await fx.players(4);
      const m = await finishedMatch("Wingman", 0, { one: [a, b], two: [c, d] });
      await play(m.ctx, [a], [c, d]);
      expect(await generate(m.id)).toBe(4);
      expect(Object.keys(await rated(m.id)).sort()).toEqual([a, b, c, d].sort());
    });

    it("a Competitive 5v5 with no events still rates all ten", async () => {
      const players = await fx.players(10);
      const m = await finishedMatch("Competitive", 0, {
        one: players.slice(0, 5),
        two: players.slice(5),
      });
      expect(await generate(m.id)).toBe(10);
    });

    it("substitute slots configured but none seated: identical to before", async () => {
      const players = await fx.players(10);
      const m = await finishedMatch("Competitive", 2, {
        one: players.slice(0, 5),
        two: players.slice(5),
      });
      await play(m.ctx, players.slice(0, 2), players.slice(5, 7));
      expect(await generate(m.id)).toBe(10);
    });
  });
});
