import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// DEAFCS: deleting a league season (tbd_league_seasons) deletes its division
// tournaments' matches in SQL. A played match would take its results,
// statistics, demo and clip rows with it and leave the files in storage, so
// the delete is refused unless every match is genuinely unplayed.
describe("league season delete (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let tier = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("LeagueSeasonDeleteTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const PLAYED = "This season has played matches, so it cannot be deleted.";
  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  // A season whose one division runs the given tournament (if any).
  const season = async (tournamentId: string | null) => {
    // Names and tiers are unique; tiers start above any seeded division.
    tier++;
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO league_seasons (name) VALUES ($1) RETURNING id`,
      [`Test season ${tier}`],
    );
    if (tournamentId) {
      const [division] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO league_divisions (name, tier) VALUES ($1, $2) RETURNING id`,
        [`Test division ${tier}`, 1000 + tier],
      );
      await postgres.query(
        `INSERT INTO league_season_divisions
           (league_season_id, league_division_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [row.id, division.id, tournamentId],
      );
    }
    return row.id;
  };

  const deleteSeason = (seasonId: string) =>
    postgres.query(`DELETE FROM league_seasons WHERE id = $1`, [seasonId]);

  const exists = async (table: string, id: string) =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM ${table} WHERE id = $1`,
        [id],
      )
    ).length === 1;

  const roundOneMatch = async (stageId: string) =>
    (await tfx.getBrackets(stageId)).find((b) => b.round === 1)!.match_id!;

  it("deletes an empty season", async () => {
    const id = await season(null);

    await deleteSeason(id);

    expect(await exists("league_seasons", id)).toBe(false);
  });

  it("deletes a season whose matches are all unplayed, with its tournament", async () => {
    const t = await tfx.launch(SE4, 4);
    const matchId = await roundOneMatch(t.stageIds[0]);
    const id = await season(t.id);

    await deleteSeason(id);

    expect(await exists("league_seasons", id)).toBe(false);
    expect(await exists("tournaments", t.id)).toBe(false);
    expect(await exists("matches", matchId)).toBe(false);
  });

  it("refuses a season with a played match, and deletes nothing", async () => {
    const t = await tfx.launch(SE4, 4);
    const matchId = await roundOneMatch(t.stageIds[0]);
    await tfx.winMatch(matchId);
    const id = await season(t.id);

    await expect(deleteSeason(id)).rejects.toThrow(PLAYED);

    expect(await exists("league_seasons", id)).toBe(true);
    expect(await exists("tournaments", t.id)).toBe(true);
    expect(await exists("matches", matchId)).toBe(true);
  });

  it.each([["a demo"], ["a clip"]])(
    "refuses a season when an otherwise unplayed match has %s",
    async (what) => {
      const t = await tfx.launch(SE4, 4);
      const matchId = await roundOneMatch(t.stageIds[0]);
      const [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 9 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [matchId],
      );
      if (what === "a demo") {
        await postgres.query(
          `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
           VALUES ($1, $2, $3, 1)`,
          [`demos/${matchId}/9.dem`, matchId, map.id],
        );
      } else {
        await postgres.query(
          `INSERT INTO match_clips (match_map_id, file) VALUES ($1, $2)`,
          [map.id, `clips/system/${matchId}.mp4`],
        );
      }
      const id = await season(t.id);

      await expect(deleteSeason(id)).rejects.toThrow(PLAYED);
      expect(await exists("matches", matchId)).toBe(true);
    },
  );

  // The delete locks the matches and maps before checking, so a demo still
  // being written makes it wait instead of being deleted under it.
  it("a demo written during the delete makes it wait, then refuses it", async () => {
    const t = await tfx.launch(SE4, 4);
    const matchId = await roundOneMatch(t.stageIds[0]);
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 9 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );
    const id = await season(t.id);

    await postgres.transaction(async (upload) => {
      await upload.query(
        `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
         VALUES ($1, $2, $3, 1)`,
        [`demos/${matchId}/9.dem`, matchId, map.id],
      );
      await expect(
        postgres.transaction(async (admin) => {
          await admin.query(`SET LOCAL lock_timeout = '300ms'`);
          await admin.query(`DELETE FROM league_seasons WHERE id = $1`, [id]);
        }),
      ).rejects.toThrow(/lock timeout/i);
    });

    await expect(deleteSeason(id)).rejects.toThrow(PLAYED);
    expect(await exists("league_seasons", id)).toBe(true);
    expect(await exists("matches", matchId)).toBe(true);
  });
});
