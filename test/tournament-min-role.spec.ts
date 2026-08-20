import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, seedRegionWithServer, SqlTestDb } from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Exercises meets_min_role() directly, the same way Hasura evaluates
// computed-field permission checks: a plain SELECT with an explicit
// session JSON. Enforcement of the actual insert permissions (team and
// individual registration) is covered separately in
// tournament-min-role-metadata.spec.ts, since raw SQL here bypasses
// Hasura's declarative check expressions entirely (no Postgres RLS).
describe("meets_min_role (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMinRoleTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199961000000n);
    tournaments = new TournamentFixtures(postgres, fx);
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
    await postgres.query("DELETE FROM players");
  });

  const session = (steamId: string, role: string) =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

  const meetsMinRole = async (
    tournamentId: string,
    role: string,
    steamId = "76561199961000001",
  ) => {
    const [row] = await postgres.query<Array<{ allowed: boolean | null }>>(
      "SELECT meets_min_role(t, $2::json) AS allowed FROM tournaments t WHERE id = $1",
      [tournamentId, session(steamId, role)],
    );
    // Hasura treats NULL as denied; collapse for assertions.
    return row.allowed === true;
  };

  const setMinRole = (tournamentId: string, minRole: string | null) =>
    postgres.query("UPDATE tournaments SET min_role = $1 WHERE id = $2", [
      minRole,
      tournamentId,
    ]);

  it("new tournaments default min_role to verified_user", async () => {
    // TournamentFixtures.createTournament() explicitly sets min_role to
    // NULL (see its own comment) so the rest of the suite's fixture-created
    // tournaments -- which enroll default-role 'user' fixture players --
    // aren't newly gated by roster-insert enforcement of that default. This
    // test is specifically about the column default itself, so it inserts
    // directly rather than going through that fixture.
    const organizer = await fx.player();
    const optionsId = await fx.matchOptions();
    const [t] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("cup"), organizer, optionsId],
    );
    const [row] = await postgres.query<Array<{ min_role: string }>>(
      "SELECT min_role FROM tournaments WHERE id = $1",
      [t.id],
    );
    expect(row.min_role).toBe("verified_user");
  });

  it("unrestricted (min_role null) allows every real role, including guest", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, null);

    for (const role of [
      "guest",
      "user",
      "verified_user",
      "streamer",
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ]) {
      expect(await meetsMinRole(t.id, role)).toBe(true);
    }
  });

  it("verified_user minimum: lower denied, equal and higher allowed", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "verified_user");

    expect(await meetsMinRole(t.id, "user")).toBe(false);
    expect(await meetsMinRole(t.id, "verified_user")).toBe(true);
    expect(await meetsMinRole(t.id, "streamer")).toBe(true);
    expect(await meetsMinRole(t.id, "moderator")).toBe(true);
    expect(await meetsMinRole(t.id, "match_organizer")).toBe(true);
    expect(await meetsMinRole(t.id, "tournament_organizer")).toBe(true);
    expect(await meetsMinRole(t.id, "administrator")).toBe(true);
  });

  it("a higher configured minimum still allows equal and higher, denies below", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "match_organizer");

    expect(await meetsMinRole(t.id, "user")).toBe(false);
    expect(await meetsMinRole(t.id, "verified_user")).toBe(false);
    expect(await meetsMinRole(t.id, "streamer")).toBe(false);
    expect(await meetsMinRole(t.id, "moderator")).toBe(false);
    expect(await meetsMinRole(t.id, "match_organizer")).toBe(true);
    expect(await meetsMinRole(t.id, "tournament_organizer")).toBe(true);
    expect(await meetsMinRole(t.id, "administrator")).toBe(true);
  });

  it("guests are denied whenever a minimum role is configured", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "user");
    expect(await meetsMinRole(t.id, "guest")).toBe(false);
  });

  it("fails closed for a missing or unknown session role", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "verified_user");

    const [missing] = await postgres.query<Array<{ allowed: boolean | null }>>(
      "SELECT meets_min_role(t, $2::json) AS allowed FROM tournaments t WHERE id = $1",
      [t.id, JSON.stringify({ "x-hasura-user-id": "76561199961000002" })],
    );
    expect(missing.allowed === true).toBe(false);

    expect(await meetsMinRole(t.id, "not-a-real-role")).toBe(false);
  });
});

// Exercises player_meets_min_role() directly -- the target-player
// counterpart to meets_min_role() above. Same raw-SQL caveat: this bypasses
// Hasura's declarative check expressions and the tbi_tournament_team_roster
// trigger entirely; actual enforcement of the roster insert/update
// permissions and the trigger's unconditional gate is covered by
// tournament-min-role-metadata.spec.ts.
describe("player_meets_min_role (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPlayerMinRoleTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
    tournaments = new TournamentFixtures(postgres, fx);
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
    await postgres.query("DELETE FROM players");
  });

  const setMinRole = (tournamentId: string, minRole: string | null) =>
    postgres.query("UPDATE tournaments SET min_role = $1 WHERE id = $2", [
      minRole,
      tournamentId,
    ]);

  const setPlayerRole = (steamId: string, role: string) =>
    postgres.query("UPDATE players SET role = $1 WHERE steam_id = $2", [
      role,
      steamId,
    ]);

  const playerMeetsMinRole = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ allowed: boolean | null }>>(
      "SELECT player_meets_min_role($1, $2) AS allowed",
      [tournamentId, steamId],
    );
    // Hasura treats NULL as denied; collapse for assertions, same as
    // meetsMinRole() above.
    return row.allowed === true;
  };

  it("unrestricted (min_role null) allows a normal user-role player", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, null);
    const player = await fx.player();
    await setPlayerRole(player, "user");

    expect(await playerMeetsMinRole(t.id, player)).toBe(true);
  });

  it("verified_user minimum: a normal user-role target is denied, verified and above are allowed", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "verified_user");

    const belowPlayer = await fx.player();
    await setPlayerRole(belowPlayer, "user");
    expect(await playerMeetsMinRole(t.id, belowPlayer)).toBe(false);

    for (const role of [
      "verified_user",
      "streamer",
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ]) {
      const player = await fx.player();
      await setPlayerRole(player, role);
      expect(await playerMeetsMinRole(t.id, player)).toBe(true);
    }
  });

  it("fails closed for a target player that doesn't exist", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "verified_user");

    expect(await playerMeetsMinRole(t.id, "76561199969999999")).toBe(false);
  });

  it("re-evaluates the target player's current role, not a session role passed in by the caller -- there is no session argument", async () => {
    const t = await tournaments.createTournament([]);
    await setMinRole(t.id, "verified_user");
    const player = await fx.player();
    await setPlayerRole(player, "user");
    expect(await playerMeetsMinRole(t.id, player)).toBe(false);

    await setPlayerRole(player, "verified_user");
    expect(await playerMeetsMinRole(t.id, player)).toBe(true);
  });
});
