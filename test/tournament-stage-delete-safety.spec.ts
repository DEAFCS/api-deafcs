import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";

describe("Manage stage deletion safety (real SQL)", () => {
  let db: SqlTestDb;
  let fixtures: TournamentFixtures;
  beforeAll(async () => {
    db = await bootMigratedDb("ManageStageDeleteSafety");
    await seedRegionWithServer(db.postgres, "TestA");
    fixtures = new TournamentFixtures(db.postgres, new Fixtures(db.postgres, 76561199800000000n));
  }, 600000);
  afterAll(async () => { await db?.stop(); });
  const stages = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }, { type: "SingleElimination", order: 2, minTeams: 4, maxTeams: 4 }];

  it("removes a setup stage and resequences remaining stages", async () => {
    const t = await fixtures.createTournament(stages);
    await db.postgres.query('DELETE FROM tournament_stages WHERE id = $1', [t.stageIds[0]]);
    const rows = await db.postgres.query<any[]>('SELECT "order" FROM tournament_stages WHERE tournament_id = $1', [t.id]);
    expect(rows).toEqual([{ order: 1 }]);
  });
  it.each(["RegistrationClosed", "Live", "Paused", "Finished"])("rejects a direct stage delete in %s and preserves its bracket", async status => {
    const t = await fixtures.createTournament(stages);
    // Session-independent stage deletion safeguard: an organizer cannot bypass
    // the UI by submitting a direct GraphQL mutation.
    await db.postgres.query("ALTER TABLE tournaments DISABLE TRIGGER tbu_tournaments");
    await db.postgres.query("ALTER TABLE tournaments DISABLE TRIGGER tau_tournaments");
    try {
      await db.postgres.query('UPDATE tournaments SET status = $1 WHERE id = $2', [status, t.id]);
    } finally {
      await db.postgres.query("ALTER TABLE tournaments ENABLE TRIGGER tbu_tournaments");
      await db.postgres.query("ALTER TABLE tournaments ENABLE TRIGGER tau_tournaments");
    }
    const before = await db.postgres.query<any[]>('SELECT id FROM tournament_brackets WHERE tournament_stage_id = $1 ORDER BY id', [t.stageIds[0]]);
    await expect(db.postgres.query('DELETE FROM tournament_stages WHERE id = $1', [t.stageIds[0]])).rejects.toThrow(/after its bracket has been drawn/);
    expect(await db.postgres.query<any[]>('SELECT id FROM tournament_brackets WHERE tournament_stage_id = $1 ORDER BY id', [t.stageIds[0]])).toEqual(before);
  });
  it("retains whole-tournament cascade cleanup", async () => {
    const t = await fixtures.createTournament(stages);
    await db.postgres.query("ALTER TABLE tournaments DISABLE TRIGGER tbu_tournaments");
    await db.postgres.query("ALTER TABLE tournaments DISABLE TRIGGER tau_tournaments");
    try {
      await db.postgres.query("UPDATE tournaments SET status = 'Finished' WHERE id = $1", [t.id]);
    } finally {
      await db.postgres.query("ALTER TABLE tournaments ENABLE TRIGGER tbu_tournaments");
      await db.postgres.query("ALTER TABLE tournaments ENABLE TRIGGER tau_tournaments");
    }
    await db.postgres.query('DELETE FROM tournaments WHERE id = $1', [t.id]);
    expect(await db.postgres.query<any[]>('SELECT id FROM tournament_stages WHERE tournament_id = $1', [t.id])).toEqual([]);
  });
});
