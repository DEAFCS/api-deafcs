import fs from "fs";
import path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Regression test for a real production incident: hasura/functions/players/
// *.sql is applied alphabetically by HasuraService.apply(), and with
// Postgres's default check_function_bodies = on, CREATE FUNCTION for a
// LANGUAGE SQL body resolves every function it calls immediately -- not
// lazily at first call. The original implementation split
// has_accepted_current_terms (which calls player_has_accepted_current_terms)
// into two files, and "has_..." sorts before "player_..." alphabetically, so
// production failed with "player_has_accepted_current_terms(bigint) does not
// exist" the first time this shipped. This suite's own test containers
// didn't reproduce it (their ambient check_function_bodies default doesn't
// match production), which is exactly why this test forces
// check_function_bodies = on explicitly rather than trusting the container
// default, and applies the real files from disk in the same alphabetical
// order the production loader uses.
describe("hasura/functions/players loader order (production check_function_bodies=on)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const FUNCTIONS_DIR = path.resolve("./hasura/functions/players");

  beforeAll(async () => {
    db = await bootMigratedDb("FunctionLoaderOrderTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("check_function_bodies is explicitly on for this test, not relying on the container default", async () => {
    await postgres.query("SET check_function_bodies = on");
    const [row] = await postgres.query<
      Array<{ check_function_bodies: string }>
    >("SHOW check_function_bodies");
    expect(row.check_function_bodies).toBe("on");
  });

  it("applies every hasura/functions/players/*.sql file from a clean slate, in the same alphabetical order production uses, and the Terms functions resolve dependency order correctly", async () => {
    // Start from neither function defined -- same as a fresh install. The
    // bug can only be reproduced from a clean slate: once both functions
    // already exist, CREATE OR REPLACE never re-triggers the dependency
    // check that broke on first deploy.
    await postgres.query(
      "DROP FUNCTION IF EXISTS public.has_accepted_current_terms(public.players)",
    );
    await postgres.query(
      "DROP FUNCTION IF EXISTS public.player_has_accepted_current_terms(bigint)",
    );

    const files = fs.readdirSync(FUNCTIONS_DIR).sort();
    expect(files).toContain("has_accepted_current_terms.sql");
    // Confirms the fix itself: the primitive is no longer a second file that
    // could sort after its dependent -- there is nothing named
    // player_has_accepted_current_terms.sql left to apply out of order.
    expect(files).not.toContain("player_has_accepted_current_terms.sql");

    for (const file of files) {
      const sql = fs.readFileSync(path.join(FUNCTIONS_DIR, file), "utf8");
      // Mirrors HasuraService.apply()'s own per-file transaction wrapping,
      // with check_function_bodies pinned local-to-transaction so it holds
      // regardless of which pooled connection executes it.
      await postgres.query(
        `begin;set local check_function_bodies = on;${sql};commit;`,
      );
    }

    const proc = await postgres.query<Array<{ proname: string }>>(
      `SELECT proname FROM pg_proc
       WHERE proname IN ('has_accepted_current_terms', 'player_has_accepted_current_terms')
       ORDER BY proname`,
    );
    expect(proc.map((p) => p.proname)).toEqual([
      "has_accepted_current_terms",
      "player_has_accepted_current_terms",
    ]);

    // Prove dependency resolution actually works end to end, not just that
    // CREATE succeeded: seed a real acceptance and confirm both functions
    // agree on the answer.
    const steamId = "900000000000000001";
    await postgres.query(
      "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
      [steamId, "loader-order-test"],
    );
    const [{ value: version }] = await postgres.query<
      Array<{ value: string }>
    >("SELECT value FROM settings WHERE name = 'public.terms_version'");

    const [before] = await postgres.query<Array<{ accepted: boolean }>>(
      "SELECT has_accepted_current_terms(p) AS accepted FROM players p WHERE steam_id = $1",
      [steamId],
    );
    expect(before.accepted).toBe(false);

    await postgres.query(
      "INSERT INTO player_terms_acceptances (player_steam_id, terms_version) VALUES ($1, $2)",
      [steamId, version],
    );

    const [afterAccept] = await postgres.query<Array<{ accepted: boolean }>>(
      "SELECT has_accepted_current_terms(p) AS accepted FROM players p WHERE steam_id = $1",
      [steamId],
    );
    expect(afterAccept.accepted).toBe(true);

    const [direct] = await postgres.query<Array<{ accepted: boolean }>>(
      "SELECT player_has_accepted_current_terms($1) AS accepted",
      [steamId],
    );
    expect(direct.accepted).toBe(true);

    await postgres.query(
      "DELETE FROM player_terms_acceptances WHERE player_steam_id = $1",
      [steamId],
    );
    await postgres.query("DELETE FROM players WHERE steam_id = $1", [
      steamId,
    ]);
  });
});
