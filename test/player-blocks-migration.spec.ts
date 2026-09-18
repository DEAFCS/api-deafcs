import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

describe("player_blocks migration", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerBlocksMigrationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_blocks");
    await postgres.query("DELETE FROM friends");
    await postgres.query("DELETE FROM team_invites");
    await postgres.query("DELETE FROM lobby_players");
    await postgres.query("DELETE FROM lobbies");
    // Deliberately not a direct "DELETE FROM team_roster" -- the admin-guard
    // trigger on that table (tbud_team_roster_admin_guard) rejects removing
    // a team's last Admin row directly. Deleting the parent team instead
    // cascades into team_roster, which that same trigger explicitly allows
    // (its "parent row already gone" branch).
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM verification_applications");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  it("installs the table, view and triggers", async () => {
    const [state] = await postgres.query<
      Array<{
        table_name: string | null;
        view_name: string | null;
        guard_friends: string | null;
        guard_lobby: string | null;
        guard_team: string | null;
        guard_verification: string | null;
      }>
    >(
      `SELECT
         to_regclass('public.player_blocks')::text AS table_name,
         to_regclass('public.v_my_blocks')::text AS view_name,
         to_regprocedure('public.guard_friends_not_blocked()')::text AS guard_friends,
         to_regprocedure('public.guard_lobby_players_not_blocked()')::text AS guard_lobby,
         to_regprocedure('public.guard_team_roster_not_blocked()')::text AS guard_team,
         to_regprocedure('public.guard_verification_application_cooldown()')::text AS guard_verification`,
    );
    expect(state).toEqual({
      table_name: "player_blocks",
      view_name: "v_my_blocks",
      guard_friends: "guard_friends_not_blocked()",
      guard_lobby: "guard_lobby_players_not_blocked()",
      guard_team: "guard_team_roster_not_blocked()",
      guard_verification: "guard_verification_application_cooldown()",
    });
  });

  it("cannot block yourself", async () => {
    const a = await fx.player("A");
    await expect(
      runAsUser(postgres, a, "user", (query) =>
        query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [a]),
      ),
    ).rejects.toThrow("cannot block yourself");
  });

  it("blocking is idempotent (duplicate blocks do not error)", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );
    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    const rows = await postgres.query(
      "SELECT * FROM player_blocks WHERE blocker_steam_id = $1 AND blocked_steam_id = $2",
      [a, b],
    );
    expect(rows).toHaveLength(1);
  });

  it("blocking removes an existing accepted friendship and any pending request, in either direction", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");

    await postgres.query(
      "INSERT INTO friends (player_steam_id, other_player_steam_id, status) VALUES ($1, $2, 'Accepted')",
      [a, b],
    );

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    const friendRows = await postgres.query(
      "SELECT 1 FROM friends WHERE (player_steam_id = $1 AND other_player_steam_id = $2) OR (player_steam_id = $2 AND other_player_steam_id = $1)",
      [a, b],
    );
    expect(friendRows).toHaveLength(0);
  });

  it("prevents a new friend request in either direction while a block exists", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    await expect(
      runAsUser(postgres, b, "user", (query) =>
        query("INSERT INTO v_my_friends (steam_id) VALUES ($1)", [a]),
      ),
    ).rejects.toThrow("cannot create a friend relationship where a block exists");

    await expect(
      runAsUser(postgres, a, "user", (query) =>
        query("INSERT INTO v_my_friends (steam_id) VALUES ($1)", [b]),
      ),
    ).rejects.toThrow("cannot create a friend relationship where a block exists");
  });

  it("also guards direct inserts into the base friends table (the syncSteamFriends bypass path)", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    await expect(
      postgres.query(
        "INSERT INTO friends (player_steam_id, other_player_steam_id, status) VALUES ($1, $2, 'Accepted')",
        [a, b],
      ),
    ).rejects.toThrow("cannot create a friend relationship where a block exists");
  });

  it("unblocking does not restore the removed friendship, and only the blocker's own row is removable", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    // b cannot unblock a's block of b (only the blocker can remove their own row).
    await runAsUser(postgres, b, "user", (query) =>
      query("DELETE FROM v_my_blocks WHERE steam_id = $1", [a]),
    );
    const stillBlocked = await postgres.query(
      "SELECT 1 FROM player_blocks WHERE blocker_steam_id = $1 AND blocked_steam_id = $2",
      [a, b],
    );
    expect(stillBlocked).toHaveLength(1);

    // a unblocks b.
    await runAsUser(postgres, a, "user", (query) =>
      query("DELETE FROM v_my_blocks WHERE steam_id = $1", [b]),
    );
    const nowUnblocked = await postgres.query(
      "SELECT 1 FROM player_blocks WHERE blocker_steam_id = $1 AND blocked_steam_id = $2",
      [a, b],
    );
    expect(nowUnblocked).toHaveLength(0);

    // Friendship was NOT restored by unblocking.
    const friendRows = await postgres.query(
      "SELECT 1 FROM friends WHERE (player_steam_id = $1 AND other_player_steam_id = $2) OR (player_steam_id = $2 AND other_player_steam_id = $1)",
      [a, b],
    );
    expect(friendRows).toHaveLength(0);

    // Either player may now send a brand-new request.
    await expect(
      runAsUser(postgres, a, "user", (query) =>
        query("INSERT INTO v_my_friends (steam_id) VALUES ($1)", [b]),
      ),
    ).resolves.toBeDefined();
  });

  it("select_permissions-equivalent behavior: my_blocks only ever reflects the blocker's own outgoing blocks", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");
    const c = await fx.player("C");

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );
    await runAsUser(postgres, c, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [a]),
    );

    const aBlocks = await postgres.query<Array<{ steam_id: string }>>(
      "SELECT steam_id FROM v_my_blocks WHERE blocker_steam_id = $1",
      [a],
    );
    expect(aBlocks.map((r) => r.steam_id)).toEqual([b]);
  });

  // lobbies has its own AFTER INSERT trigger (hasura/triggers/lobby.sql)
  // that auto-enrolls the creator as captain, reading a *strict*
  // current_setting('hasura.user') (no missing_ok) -- creating one has to
  // go through runAsUser, matching test/lobbies.spec.ts's own createLobby
  // helper, or a freshly-pooled connection that has never set that session
  // GUC errors with "unrecognized configuration parameter". No manual
  // captain insert needed -- the trigger already creates that row.
  const createLobby = (creator: string) =>
    runAsUser(postgres, creator, "user", async (query) => {
      const [row] = (await query(
        "INSERT INTO lobbies (access) VALUES ('Open') RETURNING id",
      )) as Array<{ id: string }>;
      return row.id;
    });

  it("prevents inviting a blocked player to a matchmaking lobby, in either direction", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");
    const lobbyId = await createLobby(a);

    await runAsUser(postgres, a, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [b]),
    );

    await expect(
      postgres.query(
        "INSERT INTO lobby_players (lobby_id, steam_id, invited_by_steam_id) VALUES ($1, $2, $3)",
        [lobbyId, b, a],
      ),
    ).rejects.toThrow("cannot invite a blocked player");
  });

  it("does not interfere with a normal (unblocked) lobby invite", async () => {
    const a = await fx.player("A");
    const b = await fx.player("B");
    const lobbyId = await createLobby(a);

    await expect(
      postgres.query(
        "INSERT INTO lobby_players (lobby_id, steam_id, invited_by_steam_id) VALUES ($1, $2, $3)",
        [lobbyId, b, a],
      ),
    ).resolves.toBeDefined();
  });

  it("prevents inviting a blocked player to a team", async () => {
    const { id: teamId, owner } = await fx.team();
    const target = await fx.player("Target");

    await runAsUser(postgres, owner, "user", (query) =>
      query("INSERT INTO v_my_blocks (steam_id) VALUES ($1)", [target]),
    );

    await expect(
      runAsUser(postgres, owner, "user", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
          [teamId, target],
        ),
      ),
    ).rejects.toThrow("cannot invite a blocked player");
  });

  // account_declaration_accepted_at is required by a separate, pre-existing
  // guard (tbi_verification_applications) unrelated to the cooldown trigger
  // under test here -- every insert needs it set or that guard rejects
  // first, regardless of the cooldown state.
  const insertApplication = (
    steamId: string,
    extraColumns = "",
    extraValues: string[] = [],
    params: unknown[] = [],
  ) =>
    postgres.query(
      `INSERT INTO verification_applications
         (player_steam_id, is_deaf, country, found_via, account_declaration_accepted_at${extraColumns})
       VALUES ($1, 'yes', 'US', 'friend', now()${extraValues.map((v) => `, ${v}`).join("")})`,
      [steamId, ...params],
    );

  it("verification application: one pending application is allowed; a second pending is still blocked by the existing unique index", async () => {
    const a = await fx.player("A");
    await insertApplication(a);
    await expect(insertApplication(a)).rejects.toThrow();
  });

  it("verification application: blocks resubmission within 24 hours of a rejection, using only the player's own steam id and timestamps", async () => {
    const a = await fx.player("A");
    await insertApplication(a, ", status, reviewed_at", [
      "'rejected'",
      "now() - interval '1 hour'",
    ]);

    await expect(insertApplication(a)).rejects.toThrow(
      "you must wait 24 hours",
    );
  });

  it("verification application: allows resubmission once the 24-hour cooldown has passed", async () => {
    const a = await fx.player("A");
    await insertApplication(a, ", status, reviewed_at", [
      "'rejected'",
      "now() - interval '25 hours'",
    ]);

    await expect(insertApplication(a)).resolves.toBeDefined();
  });

  it("verification application: a first-time applicant is never rejected by the cooldown guard", async () => {
    const a = await fx.player("A");
    await expect(insertApplication(a)).resolves.toBeDefined();
  });

  it("rolls the migration back cleanly in the disposable database", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const down = fs.readFileSync(
      path.resolve(
        "hasura/migrations/default/1878000012000_player_blocks/down.sql",
      ),
      "utf8",
    );
    await postgres.query(down);
    const [state] = await postgres.query<
      Array<{ table_name: string | null; guard_verification: string | null }>
    >(
      `SELECT
         to_regclass('public.player_blocks')::text AS table_name,
         to_regprocedure('public.guard_verification_application_cooldown()')::text AS guard_verification`,
    );
    expect(state).toEqual({ table_name: null, guard_verification: null });
  });
});
