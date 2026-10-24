import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The rating a player "has" right now (players.elo / get_player_elo: profile,
// matchmaking and draft balancing, friends, tournament ELO limits) follows the
// active season: the season's own rating, or its starting ELO (5000) before
// the player's first match of that season. Earlier seasons keep their rows.
describe("active-season ELO (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("SeasonActiveEloTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199550000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_elo");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await fx.enableSeasons();
  });

  const ts = async (sql: string) =>
    (
      await postgres.query<Array<{ t: string }>>(`SELECT (${sql})::text AS t`)
    )[0].t;

  // A rated match ended at `at` (SQL). The winner is set first: tbu_matches
  // stamps ended_at = now() when it is set, so the end time comes after.
  const rated = async (
    type: "Competitive" | "Wingman" | "Duel",
    one: string[],
    two: string[],
    at: string,
  ) => {
    const m = await fx.match({ type, bestOf: 1 });
    for (const s of one) await fx.lineupPlayer(m.lineup_1_id, s);
    for (const s of two) await fx.lineupPlayer(m.lineup_2_id, s);
    await postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [m.id],
    );
    await postgres.query(`UPDATE matches SET ended_at = ${at} WHERE id = $1`, [
      m.id,
    ]);
    await postgres.query("SELECT generate_player_elo_for_match($1)", [m.id]);
    return m;
  };
  const current = async (steam: string) =>
    (
      await postgres.query<Array<{ elo: Record<string, number | null> }>>(
        "SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1",
        [steam],
      )
    )[0].elo;
  const lastIn = async (steam: string, type: string, seasonId: string) =>
    (
      await postgres.query<Array<{ current: number }>>(
        `SELECT current::int FROM player_elo
          WHERE steam_id = $1 AND type = $2 AND season_id = $3
          ORDER BY created_at DESC LIMIT 1`,
        [steam, type, seasonId],
      )
    )[0]?.current;

  // Season 1 = [now - 20 days, now - 1 day); every player below has played
  // all three modes in it, winning or losing, so no Season 1 rating is 5000.
  const season1History = async () => {
    const season1 = await fx.season(
      await ts("now() - interval '20 days'"),
      await ts("now() - interval '1 day'"),
    );
    const one = await fx.players(5);
    const two = await fx.players(5);
    await rated("Competitive", one, two, "now() - interval '10 days'");
    await rated(
      "Wingman",
      one.slice(0, 2),
      two.slice(0, 2),
      "now() - interval '9 days'",
    );
    await rated("Duel", [one[0]], [two[0]], "now() - interval '8 days'");
    return { season1, one, two };
  };
  const startSeason2 = async () =>
    fx.season(await ts("now() - interval '1 day'"));

  it("during Season 1 everyone keeps showing their current Season 1 rating", async () => {
    const season1 = await fx.season(await ts("now() - interval '20 days'"));
    const one = await fx.players(5);
    const two = await fx.players(5);
    await rated("Competitive", one, two, "now() - interval '2 days'");
    await rated("Duel", [one[0]], [two[0]], "now() - interval '1 day'");
    const elo = await current(one[0]);
    expect(elo.competitive).toBe(await lastIn(one[0], "Competitive", season1));
    expect(elo.duel).toBe(await lastIn(one[0], "Duel", season1));
    expect(elo.competitive).not.toBe(5000);
    // A mode never played this season: the starting ELO.
    expect(elo.wingman).toBe(5000);
  });

  it("when Season 2 starts, everyone without a Season 2 match is at 5000 in every mode", async () => {
    const { one, two } = await season1History();
    await startSeason2();
    for (const steam of [one[0], two[0], one[1]]) {
      expect(await current(steam)).toMatchObject({
        competitive: 5000,
        wingman: 5000,
        duel: 5000,
      });
    }
  });

  it("after their first Season 2 match a player shows their actual Season 2 rating", async () => {
    const { one, two } = await season1History();
    const season2 = await startSeason2();
    await rated("Competitive", one, two, "now() - interval '2 hours'");
    const elo = await current(one[0]);
    expect(elo.competitive).toBe(await lastIn(one[0], "Competitive", season2));
    expect(elo.competitive).toBeGreaterThan(5000);
    expect((await current(two[0])).competitive).toBeLessThan(5000);
    // Modes not played yet in Season 2 stay at the starting ELO.
    expect(elo.duel).toBe(5000);
  });

  it("keeps the final Season 1 rating in the Season 1 records", async () => {
    const { season1, one } = await season1History();
    const final = await lastIn(one[0], "Competitive", season1);
    await startSeason2();
    const [row] = await postgres.query<Array<{ season1: number }>>(
      "SELECT get_player_season_elo_by_type(p, 'Competitive', $2)::int AS season1 FROM players p WHERE steam_id = $1",
      [one[0], season1],
    );
    expect(row.season1).toBe(final);
    expect(final).not.toBe(5000);
  });

  it("tournament ELO limits read the active-season rating too", async () => {
    const { one } = await season1History();
    await startSeason2();
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
      "Competitive",
    );
    const [row] = await postgres.query<Array<{ elo: string }>>(
      "SELECT get_tournament_player_elo($1, $2)::text AS elo",
      [t.id, one[0]],
    );
    expect(Number(row.elo)).toBe(5000);
  });

  it("with no active season (between seasons or seasons off) it is the player's latest rating, as before", async () => {
    await season1History();
    const [steam] = (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM player_elo WHERE type = 'Competitive' ORDER BY created_at DESC LIMIT 1",
      )
    ).map((r) => r.steam_id);
    const [latest] = await postgres.query<Array<{ current: number }>>(
      "SELECT current::int FROM player_elo WHERE steam_id = $1 AND type = 'Competitive' ORDER BY created_at DESC LIMIT 1",
      [steam],
    );
    // Season 1 ended a day ago and no Season 2 exists: between seasons.
    expect((await current(steam)).competitive).toBe(latest.current);
    await fx.enableSeasons(false);
    expect((await current(steam)).competitive).toBe(latest.current);
  });
});
