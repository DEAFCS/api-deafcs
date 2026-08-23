import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import {
  bootContainerAndMigrate,
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// leaderboard_entries is a zero-row "type-definition" table used purely as
// the SETOF return type for get_leaderboard() / get_event_leaderboard() /
// get_league_season_leaderboard(). This spec proves:
//   1. the new player_custom_avatar_url column is returned correctly
//      (custom avatar when set, Steam avatar_url fallback otherwise) for
//      the leaderboard category actually shown by default (elo)
//   2. every one of the 10 producer SELECTs across all 3 functions still
//      executes without a "structure of query does not match function
//      result type" error now that the composite type is wider - the exact
//      risk this migration was designed to avoid
//   3. Hasura metadata stays consistent and player_custom_avatar_url is
//      actually queryable over GraphQL as the guest role
describe("leaderboard_entries.player_custom_avatar_url", () => {
  let db: SqlTestDb;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("LeaderboardCustomAvatarTest");
    fx = new Fixtures(db.postgres, 76561199800000000n);
    await seedRegionWithServer(db.postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.postgres.query("DELETE FROM matches");
    await db.postgres.query("DELETE FROM match_options");
    await db.postgres.query("DELETE FROM teams");
    await db.postgres.query("DELETE FROM player_terms_acceptances");
    await db.postgres.query("DELETE FROM players");
  });

  // Drives a real 1v1 Duel through the canonical write path
  // (generate_player_elo_for_match) exactly like elo.spec.ts's `duel`
  // helper, rather than hand-inserting into player_elo -- that keeps this
  // spec honest about the actual NOT NULL/type/season_id shape that table
  // requires instead of guessing at it.
  async function seedEloPlayer(
    avatarUrl: string,
    customAvatarUrl: string | null,
  ) {
    const steamId = await fx.player();
    await db.postgres.query(
      "UPDATE players SET avatar_url = $2, custom_avatar_url = $3 WHERE steam_id = $1",
      [steamId, avatarUrl, customAvatarUrl],
    );
    const opponent = await fx.player();

    const match = await fx.match({ type: "Duel", bestOf: 1 });
    await fx.lineupPlayer(match.lineup_1_id, steamId);
    await fx.lineupPlayer(match.lineup_2_id, opponent);
    // tbu_matches (trigger) forces status to 'Finished' and stamps
    // ended_at = now() as a side effect of setting winning_lineup_id -- see
    // elo.spec.ts's identical `duel` helper.
    await db.postgres.query(
      "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
      [match.id],
    );
    await db.postgres.query("SELECT generate_player_elo_for_match($1)", [
      match.id,
    ]);

    return steamId;
  }

  it("returns the custom avatar when a player has one set, over the Steam avatar", async () => {
    const withCustom = await seedEloPlayer(
      "https://steam.example/steam.png",
      "avatars/players/custom.webp",
    );

    const rows = await db.postgres.query<
      Array<{
        player_steam_id: string;
        player_avatar_url: string | null;
        player_custom_avatar_url: string | null;
      }>
    >(
      `SELECT player_steam_id, player_avatar_url, player_custom_avatar_url
       FROM get_leaderboard('elo', 0, NULL, false, NULL, NULL, 'current', 'overall')
       WHERE player_steam_id = $1`,
      [withCustom],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].player_avatar_url).toBe("https://steam.example/steam.png");
    expect(rows[0].player_custom_avatar_url).toBe(
      "avatars/players/custom.webp",
    );
  });

  it("Steam avatar_url remains correct and player_custom_avatar_url is null when no custom avatar is set", async () => {
    const steamOnly = await seedEloPlayer(
      "https://steam.example/steam-only.png",
      null,
    );

    const rows = await db.postgres.query<
      Array<{
        player_steam_id: string;
        player_avatar_url: string | null;
        player_custom_avatar_url: string | null;
      }>
    >(
      `SELECT player_steam_id, player_avatar_url, player_custom_avatar_url
       FROM get_leaderboard('elo', 0, NULL, false, NULL, NULL, 'current', 'overall')
       WHERE player_steam_id = $1`,
      [steamOnly],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].player_avatar_url).toBe(
      "https://steam.example/steam-only.png",
    );
    expect(rows[0].player_custom_avatar_url).toBeNull();
  });

  // Structural smoke test: every category dispatches to a different producer
  // function. None of them should throw a column-count mismatch now that
  // leaderboard_entries has one more column - this is the exact failure mode
  // the migration+function-edit coupling exists to prevent. An empty result
  // set is fine; a thrown error is not.
  it.each([
    "elo",
    "best_kdr",
    "best_win_rate",
    "highest_hs_pct",
    "trophies",
    "best_rating",
    "best_adr",
    "best_kpr",
    "best_kast",
    "best_udr",
  ])(
    "get_leaderboard category '%s' executes without a composite-shape error",
    async (category) => {
      await expect(
        db.postgres.query(
          `SELECT * FROM get_leaderboard($1, 0, NULL, false, NULL, NULL, 'current', 'overall')`,
          [category],
        ),
      ).resolves.not.toThrow();
    },
  );

  it("get_event_leaderboard executes without a composite-shape error", async () => {
    // A non-existent event_id: can_view_event's guard returns early (empty
    // result), but the function must still compile/execute against the
    // widened leaderboard_entries type to get that far.
    await expect(
      db.postgres.query(
        `SELECT * FROM get_event_leaderboard($1::uuid, 'rating', NULL, 10, NULL)`,
        ["00000000-0000-0000-0000-000000000000"],
      ),
    ).resolves.not.toThrow();
  });

  it("get_league_season_leaderboard executes without a composite-shape error (both branches)", async () => {
    const nonExistentSeasonId = "00000000-0000-0000-0000-000000000000";
    // HLTV-metric branch
    await expect(
      db.postgres.query(
        `SELECT * FROM get_league_season_leaderboard($1::uuid, 'best_rating', NULL)`,
        [nonExistentSeasonId],
      ),
    ).resolves.not.toThrow();
    // UDR branch
    await expect(
      db.postgres.query(
        `SELECT * FROM get_league_season_leaderboard($1::uuid, 'best_udr', NULL)`,
        [nonExistentSeasonId],
      ),
    ).resolves.not.toThrow();
  });
});

// Separate suite: real Hasura container against the migrated DB, proving the
// metadata change (public_leaderboard_entries.yaml exposing
// player_custom_avatar_url to guest) is consistent and the field is
// actually queryable over GraphQL - not just present in Postgres.
describe("leaderboard_entries Hasura metadata", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("LeaderboardCustomAvatarMetadataTest");

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: "metadata-test",
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
      })
      .withBindMounts([
        {
          source: path.resolve("./hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();

    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  it("has zero inconsistent metadata objects", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "metadata-test",
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    const result = (await response.json()) as {
      is_consistent: boolean;
      inconsistent_objects: unknown[];
    };
    expect(result).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("exposes player_custom_avatar_url on get_leaderboard to the guest role", async () => {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": "metadata-test",
        "x-hasura-role": "guest",
      },
      body: JSON.stringify({
        query: `query LeaderboardCustomAvatar {
          get_leaderboard(
            args: { _category: "elo", _window_days: 0 }
            limit: 1
          ) {
            player_steam_id
            player_avatar_url
            player_custom_avatar_url
            player_name
          }
        }`,
      }),
    });
    const result = (await response.json()) as {
      data?: unknown;
      errors?: unknown[];
    };
    expect(result.errors).toBeUndefined();
    expect(result.data).toBeDefined();
  });
});
