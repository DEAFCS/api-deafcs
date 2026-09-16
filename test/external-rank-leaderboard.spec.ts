import { PostgresService } from "../src/postgres/postgres.service";
import { FaceitService } from "../src/faceit/faceit.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("external rank leaderboard", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("ExternalRankLeaderboard");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199980000000n);
    await seedRegionWithServer(postgres, "ExternalRankTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  it("filters to verified-or-higher players and globally sorts missing ratings last with stable pagination", async () => {
    const faceitLeader = await fx.player("Faceit leader");
    const tieLowPremier = await fx.player("Tie low Premier");
    const tieHighPremier = await fx.player("Tie high Premier");
    const premierOnly = await fx.player("Premier only");
    const missingBoth = await fx.player("Missing both");
    const elevated = await fx.player("Elevated moderator");
    const unrelated = await fx.player("Imported outsider");

    await postgres.query(
      `UPDATE players
          SET role = values.role,
              faceit_elo = values.faceit_elo,
              premier_rank = values.premier_rank
         FROM (VALUES
           ($1::bigint, 'verified_user'::text, 2700::integer, 15000::integer),
           ($2::bigint, 'verified_user'::text, 2500::integer, 12000::integer),
           ($3::bigint, 'verified_user'::text, 2500::integer, 22000::integer),
           ($4::bigint, 'streamer'::text, NULL::integer, 26000::integer),
           ($5::bigint, 'verified_user'::text, NULL::integer, NULL::integer),
           ($6::bigint, 'moderator'::text, 2400::integer, NULL::integer),
           ($7::bigint, 'user'::text, 9999::integer, 99999::integer)
         ) AS values(steam_id, role, faceit_elo, premier_rank)
        WHERE players.steam_id = values.steam_id`,
      [
        faceitLeader,
        tieLowPremier,
        tieHighPremier,
        premierOnly,
        missingBoth,
        elevated,
        unrelated,
      ],
    );

    const eligible = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text
         FROM external_rank_leaderboard
        ORDER BY player_steam_id`,
    );
    expect(eligible.map((row) => row.player_steam_id)).toEqual(
      [
        faceitLeader,
        tieLowPremier,
        tieHighPremier,
        premierOnly,
        missingBoth,
        elevated,
      ].sort(),
    );

    const faceitPage = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text
         FROM external_rank_leaderboard
        ORDER BY faceit_elo DESC NULLS LAST,
                 premier_rank DESC NULLS LAST,
                 player_steam_id ASC
        LIMIT 2 OFFSET 1`,
    );
    expect(faceitPage.map((row) => row.player_steam_id)).toEqual([
      tieHighPremier,
      tieLowPremier,
    ]);

    const premierOrder = await postgres.query<
      Array<{ player_steam_id: string }>
    >(
      `SELECT player_steam_id::text
         FROM external_rank_leaderboard
        ORDER BY premier_rank DESC NULLS LAST,
                 faceit_elo DESC NULLS LAST,
                 player_steam_id ASC`,
    );
    expect(premierOrder.map((row) => row.player_steam_id)).toEqual([
      premierOnly,
      tieHighPremier,
      faceitLeader,
      tieLowPremier,
      elevated,
      missingBoth,
    ]);
  });

  it("shows a Premier match date only for an actual Steam GC timestamp", async () => {
    const player = await fx.player("Premier player");
    await postgres.query(
      `UPDATE players
          SET role = 'verified_user', premier_rank = 22150
        WHERE steam_id = $1`,
      [player],
    );

    const verifiedMatch = await fx.match({ type: "Premier" });
    const unverifiedMatch = await fx.match({ type: "Premier" });
    const verifiedAt = "2026-09-10T18:00:00.000Z";
    const unverifiedAt = "2026-09-15T18:00:00.000Z";
    await postgres.query(
      `UPDATE matches
          SET source = 'valve',
              status = 'Finished',
              started_at = CASE id WHEN $1::uuid THEN $3::timestamptz ELSE $4::timestamptz END,
              ended_at = CASE id WHEN $1::uuid THEN $3::timestamptz ELSE $4::timestamptz END,
              external_timestamp_source = CASE id
                WHEN $1::uuid THEN 'steam_gc'
                ELSE 'demo_cdn_last_modified'
              END
        WHERE id IN ($1::uuid, $2::uuid)`,
      [verifiedMatch.id, unverifiedMatch.id, verifiedAt, unverifiedAt],
    );
    await postgres.query(
      `INSERT INTO player_premier_rank_history
         (steam_id, rank, rank_type, match_id, observed_at)
       VALUES
         ($1, 22000, 11, $2, $4),
         ($1, 22150, 11, $3, $5)`,
      [player, verifiedMatch.id, unverifiedMatch.id, verifiedAt, unverifiedAt],
    );

    const [row] = await postgres.query<
      Array<{ premier_last_match_at: Date | null }>
    >(
      `SELECT premier_last_match_at
         FROM external_rank_leaderboard
        WHERE player_steam_id = $1`,
      [player],
    );
    expect(row.premier_last_match_at?.toISOString()).toBe(verifiedAt);

    await postgres.query(
      `UPDATE matches SET external_timestamp_source = NULL WHERE id = $1`,
      [verifiedMatch.id],
    );
    const [withoutProvenance] = await postgres.query<
      Array<{ premier_last_match_at: Date | null }>
    >(
      `SELECT premier_last_match_at
         FROM external_rank_leaderboard
        WHERE player_steam_id = $1`,
      [player],
    );
    expect(withoutProvenance.premier_last_match_at).toBeNull();
  });

  it("fairly advances past 100 persistent FACEIT failures while respecting successful-data staleness", async () => {
    const stalePlayers = Array.from({ length: 105 }, () => fx.nextSteam());
    const freshPlayer = fx.nextSteam();
    await postgres.query(
      `INSERT INTO players
         (steam_id, name, role, faceit_elo, faceit_updated_at, faceit_last_match_at)
       SELECT ids.steam_id::bigint,
              'fair-' || ids.ordinality,
              'verified_user',
              2000,
              CASE
                WHEN ids.steam_id = $2 THEN now() - interval '5 hours'
                ELSE now() - interval '7 hours'
              END,
              now() - interval '1 day'
         FROM unnest($1::text[]) WITH ORDINALITY AS ids(steam_id, ordinality)`,
      [[...stalePlayers, freshPlayer], freshPlayer],
    );

    const service = new FaceitService(
      { get: jest.fn().mockReturnValue("server-side-key") } as never,
      {} as never,
      {} as never,
      postgres,
      {
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        log: jest.fn(),
      } as never,
    );
    const refresh = jest
      .spyOn(service, "refreshPlayer")
      .mockResolvedValue(false);

    await expect(service.refreshVerifiedPlayers()).resolves.toEqual({
      eligible: 100,
      refreshed: 0,
      skipped: 100,
      failed: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(100);

    await expect(service.refreshVerifiedPlayers()).resolves.toEqual({
      eligible: 5,
      refreshed: 0,
      skipped: 5,
      failed: 0,
    });

    const attemptedIds = new Set(
      refresh.mock.calls.map(([attemptedSteamId]) => attemptedSteamId),
    );
    expect(attemptedIds).toEqual(new Set(stalePlayers));
    expect(attemptedIds.has(freshPlayer)).toBe(false);

    const [coverage] = await postgres.query<
      Array<{
        attempted: string;
        fresh_attempted: string;
        cached_values_preserved: boolean;
      }>
    >(
      `SELECT count(*) FILTER (
                WHERE steam_id = ANY($1::bigint[])
                  AND faceit_refresh_attempted_at IS NOT NULL
              )::text AS attempted,
              count(*) FILTER (
                WHERE steam_id = $2::bigint
                  AND faceit_refresh_attempted_at IS NOT NULL
              )::text AS fresh_attempted,
              bool_and(
                faceit_elo = 2000
                AND faceit_updated_at IS NOT NULL
                AND faceit_last_match_at IS NOT NULL
              ) AS cached_values_preserved
         FROM players
        WHERE steam_id = ANY($3::bigint[])`,
      [stalePlayers, freshPlayer, [...stalePlayers, freshPlayer]],
    );
    expect(coverage).toEqual({
      attempted: "105",
      fresh_attempted: "0",
      cached_values_preserved: true,
    });
  });
});
