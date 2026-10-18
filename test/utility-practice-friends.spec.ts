import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Join Pracc from the friends list (DEAFCS). The list can only offer a session
// its viewer can see, and can_view_utility_practice_session used to leave out
// the host's friends even where UtilityPracticeService.canJoin let them in. A
// Friends session is now visible to the host's ACCEPTED friends, and an Invite
// or Private session still is not.
describe("practice session visibility for friends (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let host: string;
  let friend: string;
  let pending: string;
  let stranger: string;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityPracticeFriendsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199720000000n);
    await seedRegionWithServer(postgres, "TestA");

    host = await fx.player();
    friend = await fx.player();
    pending = await fx.player();
    stranger = await fx.player();

    // Both directions exist in production; either one has to count.
    await postgres.query(
      "INSERT INTO friends (player_steam_id, other_player_steam_id, status) VALUES ($1, $2, 'Accepted')",
      [friend, host],
    );
    await postgres.query(
      "INSERT INTO friends (player_steam_id, other_player_steam_id, status) VALUES ($1, $2, 'Pending')",
      [host, pending],
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_practice_invites");
    await postgres.query("DELETE FROM utility_practice_sessions");
  });

  async function session(access: string, status = "Ready"): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, status, access, is_open)
       VALUES ($1::bigint, 'de_mirage', 'TestA', $2, $3, $3 = 'Open')
       RETURNING id::text AS id`,
      [host, status, access],
    );
    return row.id;
  }

  async function canView(
    sessionId: string,
    steamId: string,
    role = "user",
  ): Promise<boolean> {
    const [row] = await postgres.query<Array<{ can_view: boolean }>>(
      `SELECT can_view_utility_practice_session(s.*, $2::json) AS can_view
         FROM utility_practice_sessions s WHERE s.id = $1::uuid`,
      [
        sessionId,
        JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId }),
      ],
    );
    return row.can_view;
  }

  it("shows a Friends session to an accepted friend", async () => {
    const id = await session("Friends");

    await expect(canView(id, friend)).resolves.toBe(true);
  });

  it("does not show a Friends session to a pending friend or a stranger", async () => {
    const id = await session("Friends");

    await expect(canView(id, pending)).resolves.toBe(false);
    await expect(canView(id, stranger)).resolves.toBe(false);
  });

  it("keeps an Invite session hidden from an accepted friend who was not invited", async () => {
    const id = await session("Invite");

    await expect(canView(id, friend)).resolves.toBe(false);
  });

  it("still shows an Invite session to the player invited to it", async () => {
    const id = await session("Invite");
    await postgres.query(
      "INSERT INTO utility_practice_invites (utility_practice_session_id, steam_id, invited_by_steam_id) VALUES ($1::uuid, $2::bigint, $3::bigint)",
      [id, friend, host],
    );

    await expect(canView(id, friend)).resolves.toBe(true);
  });

  it("keeps a Private session hidden from an accepted friend", async () => {
    const id = await session("Private");

    await expect(canView(id, friend)).resolves.toBe(false);
  });

  it("shows an Open session to everybody, as before", async () => {
    const id = await session("Open");

    await expect(canView(id, friend)).resolves.toBe(true);
    await expect(canView(id, stranger)).resolves.toBe(true);
  });

  it("always shows the host their own session", async () => {
    for (const access of ["Open", "Friends", "Invite", "Private"]) {
      await expect(canView(await session(access), host)).resolves.toBe(true);
      // One live session per host (utility_practice_sessions_one_live_per_host_idx).
      await postgres.query("DELETE FROM utility_practice_sessions");
    }
  });

  it("hands a friend who can now see the session no connect string or password", async () => {
    const id = await session("Friends");
    const [row] = await postgres.query<
      Array<{ link: string | null; connect: string | null }>
    >(
      `SELECT utility_practice_connection_link(s.*, $2::json) AS link,
              utility_practice_connection_string(s.*, $2::json) AS connect
         FROM utility_practice_sessions s WHERE s.id = $1::uuid`,
      [
        id,
        JSON.stringify({ "x-hasura-role": "user", "x-hasura-user-id": friend }),
      ],
    );

    expect(row.link).toBeNull();
    expect(row.connect).toBeNull();
  });
});
