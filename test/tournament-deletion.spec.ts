import { PoolClient } from "pg";
import { PostgresService } from "./../src/postgres/postgres.service";
import { AwardsService } from "./../src/awards/awards.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// DB-level coverage for the tournament deletion fix: exercises the exact SQL
// path TournamentsController.deleteTournament runs inside
// PostgresService.transaction -- AwardsService.deleteTournamentAwardRecords,
// then deleteTournamentMatchRows (detach this tournament's own
// tournament_brackets from their matches via an atomic CTE, then delete
// match_map_demos and the matches themselves), then
// `DELETE FROM tournaments ... RETURNING id` -- against a real, migrated
// Postgres instance so the award_occurrences_calculated_tournament
// constraint, the award_recipients ON DELETE RESTRICT FK, the
// match_map_demos FKs (match_id CASCADE, match_map_id RESTRICT),
// the tbd_tournament_brackets / tad_matches trigger interaction, and the
// match/tournament FK cascades are all genuinely enforced rather than mocked.
// Controller-level concerns (auth/status/league guards, S3 cleanup ordering,
// no Hasura calls inside the transaction) are covered separately in
// src/tournaments/tournaments.controller.spec.ts.
describe("tournament deletion (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let awards: AwardsService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentDeletionTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
    tfx = new TournamentFixtures(postgres, fx);
    awards = new AwardsService(
      { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any,
      {} as any, // S3Service is not used by deleteTournamentAwardRecords
      postgres,
      { notifyPlayers: jest.fn() } as any,
    );
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM awards WHERE system_key IS NULL");
    await postgres.query("DELETE FROM seasons");
  });

  // Mirrors TournamentsController's private deleteTournamentMatchRows
  // exactly: atomically detach this tournament's own tournament_brackets from
  // their matches (locking them first, deriving match ids from the DB itself
  // rather than trusting a pre-resolved list), then delete match_map_demos
  // and finally the matches -- each match re-verified via NOT EXISTS against
  // *any* remaining tournament_brackets reference (not just this
  // tournament's) before it is touched. Returns the match ids actually
  // deleted and the clip file keys read before the cascade removed them.
  // keepPlayed mirrors the Cancelled event: every played match stays
  // (public.match_has_played_data). afterDetach (tests only) runs right after
  // the detach, to land a demo, clip or Live status in the middle of a cancel.
  const deleteTournamentMatchRows = async (
    client: PoolClient,
    tournamentId: string,
    keepPlayed = false,
    afterDetach?: (matchIds: string[], client: PoolClient) => Promise<void>,
  ): Promise<{ matchIds: string[]; clipKeys: string[] }> => {
    const detached = await client.query<{ match_id: string }>(
      `WITH owned_brackets AS (
         SELECT tb.id, tb.match_id
         FROM public.tournament_brackets tb
         JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1
           AND tb.match_id IS NOT NULL
           AND NOT (
             $2::boolean AND public.match_has_played_data(tb.match_id)
           )
         FOR UPDATE
       ),
       detached AS (
         UPDATE public.tournament_brackets tb
         SET match_id = NULL
         FROM owned_brackets ob
         WHERE tb.id = ob.id
         RETURNING ob.match_id
       )
       SELECT DISTINCT match_id FROM detached`,
      [tournamentId, keepPlayed],
    );

    const candidateIds = detached.rows.map((row) => row.match_id);
    if (candidateIds.length === 0) {
      return { matchIds: [], clipKeys: [] };
    }
    await afterDetach?.(candidateIds, client);

    const deletable = await client.query<{ id: string }>(
      `SELECT m.id FROM public.matches m
        WHERE m.id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_brackets tb
            WHERE tb.match_id = m.id
          )`,
      [candidateIds],
    );
    const matchIds = deletable.rows.map((row) => row.id);
    if (matchIds.length === 0) {
      return { matchIds: [], clipKeys: [] };
    }

    await lockForCancel(client, matchIds);

    if (keepPlayed) {
      const played = await client.query<{ played: boolean }>(
        `SELECT COALESCE(bool_or(public.match_has_played_data(id)), false) AS played
           FROM unnest($1::uuid[]) AS id`,
        [matchIds],
      );
      if (played.rows[0]?.played) {
        throw Error(
          "a cancelled tournament's match gained played data, retrying",
        );
      }
    }

    const clips = await client.query<{
      file: string | null;
      thumbnail_url: string | null;
    }>(
      `SELECT c.file, c.thumbnail_url
         FROM public.match_clips c
         JOIN public.match_maps mm ON mm.id = c.match_map_id
        WHERE mm.match_id = ANY($1::uuid[])`,
      [matchIds],
    );
    const clipKeys = clips.rows
      .flatMap((clip) => [clip.file, clip.thumbnail_url])
      .filter((key): key is string => !!key);

    const renders = await client.query<{ key: string }>(
      `SELECT 'clips/' || COALESCE(j.user_steam_id::text, 'system') || '/'
              || j.id || ext.suffix AS key
         FROM public.clip_render_jobs j
         JOIN public.match_maps mm ON mm.id = j.match_map_id
        CROSS JOIN (VALUES ('.mp4'), ('.jpg')) AS ext(suffix)
        WHERE mm.match_id = ANY($1::uuid[])
          AND j.clip_id IS NULL`,
      [matchIds],
    );
    clipKeys.push(...renders.rows.map((row) => row.key));

    if (!keepPlayed) {
      await client.query(
        `DELETE FROM public.match_map_demos WHERE match_id = ANY($1::uuid[])`,
        [matchIds],
      );
    }
    await client.query(`DELETE FROM public.matches WHERE id = ANY($1::uuid[])`, [
      matchIds,
    ]);

    return { matchIds, clipKeys };
  };

  // The locks deleteTournamentMatchRows takes before its reads (both modes).
  const lockForCancel = async (client: PoolClient, matchIds: string[]) => {
    await client.query(
      `SELECT 1 FROM public.matches WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [matchIds],
    );
    await client.query(
      `SELECT 1 FROM public.match_maps WHERE match_id = ANY($1::uuid[]) FOR UPDATE`,
      [matchIds],
    );
  };

  // Mirrors exactly what TournamentsController.deleteTournament runs inside
  // PostgresService.transaction: awards -> detach+delete match rows ->
  // tournament row.
  const deleteTournamentViaTransaction = (tournamentId: string) =>
    postgres.transaction(async (client) => {
      await awards.deleteTournamentAwardRecords(client, tournamentId);
      await deleteTournamentMatchRows(client, tournamentId);
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM public.tournaments WHERE id = $1 RETURNING id`,
        [tournamentId],
      );
      if (deleted.rows.length !== 1) {
        throw Error(
          `expected to delete exactly one tournament row, deleted ${deleted.rows.length}`,
        );
      }
    });

  const bracketMatchId = async (bracketId: string) => {
    const [row] = await postgres.query<Array<{ match_id: string | null }>>(
      `SELECT match_id FROM tournament_brackets WHERE id = $1`,
      [bracketId],
    );
    return row?.match_id ?? null;
  };

  // Attaches a demo row and a clip row to a match, exercising the
  // match_map_demos FKs and the match_maps -> match_clips CASCADE.
  const attachDemoAndClip = async (matchId: string, steamId: string) => {
    const [matchMap] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );
    const [demo] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [`demos/${matchId}/1.dem`, matchId, matchMap.id],
    );
    const [clip] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_clips (user_steam_id, match_map_id)
       VALUES ($1, $2) RETURNING id`,
      [steamId, matchMap.id],
    );
    return { matchMapId: matchMap.id, demoId: demo.id, clipId: clip.id };
  };

  const createReusableAward = async (name: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO awards (name, tier) VALUES ($1, 'gold') RETURNING id`,
      [name],
    );
    return row.id;
  };

  const createCalculatedOccurrence = async (
    awardId: string,
    tournamentId: string,
    calculationKey: string,
  ) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO award_occurrences (award_id, tournament_id, source, calculation_key)
       VALUES ($1, $2, 'tournament_calculated', $3) RETURNING id`,
      [awardId, tournamentId, calculationKey],
    );
    return row.id;
  };

  const createManualOccurrence = async (
    awardId: string,
    tournamentId: string,
  ) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO award_occurrences (award_id, tournament_id, source)
       VALUES ($1, $2, 'manual') RETURNING id`,
      [awardId, tournamentId],
    );
    return row.id;
  };

  const grantToPlayer = async (occurrenceId: string, steamId: string) => {
    await postgres.query(
      `INSERT INTO award_recipients (occurrence_id, player_steam_id) VALUES ($1, $2)`,
      [occurrenceId, steamId],
    );
  };

  const tournamentExists = async (id: string) => {
    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM tournaments WHERE id = $1`,
      [id],
    );
    return rows.length > 0;
  };

  const orphanedRecipientCount = async () => {
    const [row] = await postgres.query<Array<{ c: string }>>(
      `SELECT count(*) AS c FROM award_recipients r
       LEFT JOIN award_occurrences o ON o.id = r.occurrence_id
       WHERE o.id IS NULL`,
    );
    return Number(row.c);
  };

  const orphanedOccurrenceCount = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ c: string }>>(
      `SELECT count(*) AS c FROM award_occurrences WHERE tournament_id = $1`,
      [tournamentId],
    );
    return Number(row.c);
  };

  it("deletes a draft tournament without awards", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );

    await deleteTournamentViaTransaction(t.id);

    expect(await tournamentExists(t.id)).toBe(false);
  });

  it("deletes a tournament with award slots configured", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Champion"));
    await postgres.query(
      `INSERT INTO tournament_award_slots (tournament_id, slot, award_id)
       VALUES ($1, 'champion', $2)`,
      [t.id, awardId],
    );

    await deleteTournamentViaTransaction(t.id);

    expect(await tournamentExists(t.id)).toBe(false);
    // tournament_award_slots is ON DELETE CASCADE -- nothing left behind.
    const slots = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM tournament_award_slots WHERE tournament_id = $1`,
      [t.id],
    );
    expect(slots.length).toBe(0);
  });

  it("deletes a completed tournament with calculated occurrences (the reported failure case)", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    // Real placement calculation already produced tournament_calculated
    // occurrences via tournament_trophies -> awards backfill; deletion must
    // not violate award_occurrences_calculated_tournament.
    const occurrences = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_occurrences WHERE tournament_id = $1`,
      [t.id],
    );
    expect(occurrences.length).toBeGreaterThan(0);

    await expect(deleteTournamentViaTransaction(t.id)).resolves.toBeUndefined();
    expect(await tournamentExists(t.id)).toBe(false);
  });

  it("deletes award recipients before occurrences (no FK-restrict failure)", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const player = await fx.player();
    const awardId = await createReusableAward(fx.nextName("MVP"));
    const occurrenceId = await createCalculatedOccurrence(
      awardId,
      t.id,
      `calc-${t.id}`,
    );
    await grantToPlayer(occurrenceId, player);

    await expect(deleteTournamentViaTransaction(t.id)).resolves.toBeUndefined();

    const recipients = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_recipients WHERE occurrence_id = $1`,
      [occurrenceId],
    );
    expect(recipients.length).toBe(0);
  });

  it("deletes manual occurrences scoped to the tournament", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Special Mention"));
    const occurrenceId = await createManualOccurrence(awardId, t.id);

    await deleteTournamentViaTransaction(t.id);

    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_occurrences WHERE id = $1`,
      [occurrenceId],
    );
    expect(rows.length).toBe(0);
  });

  it("preserves the reusable award definition after the tournament is deleted", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Reusable Trophy"));
    const occurrenceId = await createCalculatedOccurrence(
      awardId,
      t.id,
      `calc-${t.id}`,
    );
    await grantToPlayer(occurrenceId, await fx.player());

    await deleteTournamentViaTransaction(t.id);

    const [award] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM awards WHERE id = $1`,
      [awardId],
    );
    expect(award).toBeDefined();
  });

  it("leaves another tournament's award data untouched", async () => {
    const target = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const other = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Shared Award"));
    await createCalculatedOccurrence(awardId, target.id, `calc-${target.id}`);
    const otherOccurrenceId = await createCalculatedOccurrence(
      awardId,
      other.id,
      `calc-${other.id}`,
    );
    await grantToPlayer(otherOccurrenceId, await fx.player());

    await deleteTournamentViaTransaction(target.id);

    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_occurrences WHERE id = $1`,
      [otherOccurrenceId],
    );
    expect(rows.length).toBe(1);
  });

  it("leaves an unrelated player's other awards untouched", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const player = await fx.player();
    const tournamentAwardId = await createReusableAward(fx.nextName("Cup Award"));
    const tournamentOccurrenceId = await createCalculatedOccurrence(
      tournamentAwardId,
      t.id,
      `calc-${t.id}`,
    );
    await grantToPlayer(tournamentOccurrenceId, player);

    // Unrelated, unscoped award for the same player (no tournament_id).
    const unscopedAwardId = await createReusableAward(fx.nextName("Legacy Trophy"));
    const [unscopedOccurrence] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO award_occurrences (award_id, source) VALUES ($1, 'manual') RETURNING id`,
      [unscopedAwardId],
    );
    await grantToPlayer(unscopedOccurrence.id, player);

    await deleteTournamentViaTransaction(t.id);

    const rows = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_recipients WHERE occurrence_id = $1`,
      [unscopedOccurrence.id],
    );
    expect(rows.length).toBe(1);
  });

  it("rolls back recipients, occurrences, and the tournament row on a forced SQL failure", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Rollback Award"));
    const occurrenceId = await createCalculatedOccurrence(
      awardId,
      t.id,
      `calc-${t.id}`,
    );
    await grantToPlayer(occurrenceId, await fx.player());

    await expect(
      postgres.transaction(async (client: PoolClient) => {
        await awards.deleteTournamentAwardRecords(client, t.id);
        // Force a failure after the award deletes but before the tournament
        // delete commits, simulating any downstream SQL error.
        await client.query(`SELECT 1/0`);
      }),
    ).rejects.toThrow();

    expect(await tournamentExists(t.id)).toBe(true);
    const occurrences = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_occurrences WHERE id = $1`,
      [occurrenceId],
    );
    expect(occurrences.length).toBe(1);
    const recipients = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_recipients WHERE occurrence_id = $1`,
      [occurrenceId],
    );
    expect(recipients.length).toBe(1);
  });

  it("deletes tournament match rows inside the SQL transaction, cascading their dependent rows", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const brackets = await tfx.getBrackets(t.stageIds[0]);
    const matchId = brackets.find((b) => b.round === 1)!.match_id!;
    const player = await fx.player();
    const { matchMapId, demoId, clipId } = await attachDemoAndClip(
      matchId,
      player,
    );

    await deleteTournamentViaTransaction(t.id);

    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeUndefined();

    const [matchMap] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_maps WHERE id = $1`,
      [matchMapId],
    );
    expect(matchMap).toBeUndefined();

    const [demo] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_map_demos WHERE id = $1`,
      [demoId],
    );
    expect(demo).toBeUndefined();

    const [clip] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_clips WHERE id = $1`,
      [clipId],
    );
    expect(clip).toBeUndefined();
  });

  // The cascade above removes match_clips, so the S3 purge after commit can
  // only remove the clip files whose keys were read before the delete.
  it("reads the deleted matches' clip keys before the cascade, and only theirs", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const other = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const otherMatchId = (await tfx.getBrackets(other.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const player = await fx.player();
    const { matchMapId } = await attachDemoAndClip(matchId, player);
    const { matchMapId: otherMatchMapId } = await attachDemoAndClip(
      otherMatchId,
      player,
    );
    await postgres.query(
      `INSERT INTO match_clips (match_map_id, file, thumbnail_url)
       VALUES ($1, 'clips/system/job-a.mp4', 'clips/system/job-a.jpg'),
              ($1, 'clips/system/job-b.mp4', NULL),
              ($2, 'clips/system/job-other.mp4', 'clips/system/job-other.jpg')`,
      [matchMapId, otherMatchMapId],
    );

    let deleted = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      deleted = await deleteTournamentMatchRows(client, t.id);
    });

    expect(deleted.matchIds).toContain(matchId);
    expect(deleted.clipKeys.sort()).toEqual([
      "clips/system/job-a.jpg",
      "clips/system/job-a.mp4",
      "clips/system/job-b.mp4",
    ]);
    const remaining = await postgres.query<Array<{ file: string | null }>>(
      `SELECT file FROM match_clips WHERE file IS NOT NULL ORDER BY file`,
    );
    expect(remaining.map((row) => row.file)).toEqual([
      "clips/system/job-other.mp4",
    ]);
  });

  // DEAFCS rule: cancelling deletes no demo, clip or thumbnail. Played matches
  // stay linked, so deleting the tournament later still finds their files.
  it("cancelling keeps matches with demos or clips linked and deletes only unplayed ones", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const [first, second] = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1,
    );
    const player = await fx.player();
    // first: a demo and a clip. second: only a clip (its demo already past
    // retention). The final has no match yet or an unplayed one.
    const { demoId } = await attachDemoAndClip(first.match_id!, player);
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [second.match_id],
    );
    await postgres.query(
      `INSERT INTO match_clips (match_map_id, file, thumbnail_url)
       VALUES ($1, 'clips/system/job-second.mp4', 'clips/system/job-second.jpg')`,
      [map.id],
    );
    const before = await tfx.getBrackets(t.stageIds[0]);
    const unplayed = before
      .filter((b) => b.match_id && b.id !== first.id && b.id !== second.id)
      .map((b) => b.match_id!);

    let cancelled = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      cancelled = await deleteTournamentMatchRows(client, t.id, true);
    });

    expect(cancelled.matchIds.sort()).toEqual(unplayed.sort());
    expect(cancelled.clipKeys).toEqual([]);
    expect(await bracketMatchId(first.id)).toBe(first.match_id);
    expect(await bracketMatchId(second.id)).toBe(second.match_id);
    const [demo] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_map_demos WHERE id = $1`,
      [demoId],
    );
    expect(demo).toBeDefined();

    // Rebuilding the bracket (reopening registration) must not delete them.
    await expect(
      postgres.query(`SELECT public.delete_tournament_brackets_and_matches($1)`, [
        t.id,
      ]),
    ).rejects.toThrow(/has played matches, so its bracket cannot be rebuilt/);
    expect(await bracketMatchId(first.id)).toBe(first.match_id);

    // Deleting the tournament removes them and answers every clip key.
    let deleted = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      await awards.deleteTournamentAwardRecords(client, t.id);
      deleted = await deleteTournamentMatchRows(client, t.id);
      await client.query(`DELETE FROM public.tournaments WHERE id = $1`, [
        t.id,
      ]);
    });
    expect(deleted.matchIds.sort()).toEqual(
      [first.match_id!, second.match_id!].sort(),
    );
    expect(deleted.clipKeys.sort()).toEqual([
      "clips/system/job-second.jpg",
      "clips/system/job-second.mp4",
    ]);
    expect(await tournamentExists(t.id)).toBe(false);
  });

  // A match can be played with nothing stored yet: Live mid-map, or its demo
  // never uploaded. Cancelling and the bracket rebuild must keep it too.
  it("cancelling keeps Live and started matches that have no demo or clip", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const [live, started] = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1,
    );
    // A match needs a map to go Live; the map itself is not played data.
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1`,
      [live.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      live.match_id,
    ]);
    await postgres.query(
      "UPDATE matches SET started_at = now() WHERE id = $1",
      [started.match_id],
    );
    const unplayed = (await tfx.getBrackets(t.stageIds[0]))
      .filter((b) => b.match_id && b.id !== live.id && b.id !== started.id)
      .map((b) => b.match_id!);

    let cancelled = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      cancelled = await deleteTournamentMatchRows(client, t.id, true);
    });

    expect(cancelled.matchIds.sort()).toEqual(unplayed.sort());
    expect(cancelled.matchIds).not.toContain(live.match_id);
    expect(cancelled.matchIds).not.toContain(started.match_id);
    expect(await bracketMatchId(live.id)).toBe(live.match_id);
    expect(await bracketMatchId(started.id)).toBe(started.match_id);

    await expect(
      postgres.query(`SELECT public.delete_tournament_brackets_and_matches($1)`, [
        t.id,
      ]),
    ).rejects.toThrow(/has played matches, so its bracket cannot be rebuilt/);
    expect(await bracketMatchId(live.id)).toBe(live.match_id);
  });

  // The re-check after the locks, for played data that is not a file. The
  // match starts inside the cancel's own transaction: from another connection
  // the matches trigger would wait on the bracket rows the cancel holds.
  it("cancelling rolls back when a match started after the detach", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    const matchId = bracket.match_id!;

    await expect(
      postgres.transaction((client) =>
        deleteTournamentMatchRows(client, t.id, true, async (ids, tx) => {
          if (ids.includes(matchId)) {
            await tx.query(
              "UPDATE matches SET started_at = now() WHERE id = $1",
              [matchId],
            );
          }
        }),
      ),
    ).rejects.toThrow(
      "a cancelled tournament's match gained played data, retrying",
    );

    // Rolled back: the bracket still points at the match, which still exists.
    expect(await bracketMatchId(bracket.id)).toBe(matchId);
    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeDefined();
  });

  // The fact the cancel path is built on: nothing in the schema stops a match
  // delete from taking its demo and clip rows (and so orphaning their files).
  it("a plain match delete silently takes its demo and clip rows", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const { demoId, clipId } = await attachDemoAndClip(
      matchId,
      await fx.player(),
    );

    await postgres.transaction(async (client) => {
      await client.query(
        `UPDATE tournament_brackets SET match_id = NULL WHERE match_id = $1`,
        [matchId],
      );
      await client.query(`DELETE FROM matches WHERE id = $1`, [matchId]);
    });

    const [demo] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_map_demos WHERE id = $1`,
      [demoId],
    );
    const [clip] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM match_clips WHERE id = $1`,
      [clipId],
    );
    expect(demo).toBeUndefined();
    expect(clip).toBeUndefined();
  });

  it("cancelling rolls back when a demo lands after the detach, and the retry keeps the match", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    const matchId = bracket.match_id!;

    // A demo only (no clip yet) commits from another connection after the
    // detach, before the locks: the case the re-check exists for.
    await expect(
      postgres.transaction((client) =>
        deleteTournamentMatchRows(client, t.id, true, async (ids) => {
          if (!ids.includes(matchId)) {
            return;
          }
          const [map] = await postgres.query<Array<{ id: string }>>(
            `INSERT INTO match_maps (match_id, map_id, "order")
             SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
            [matchId],
          );
          await postgres.query(
            `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
             VALUES ($1, $2, $3, 1)`,
            [`demos/${matchId}/1.dem`, matchId, map.id],
          );
        }),
      ),
    ).rejects.toThrow(
      "a cancelled tournament's match gained played data, retrying",
    );

    // Rolled back: the bracket still points at the match, demo intact.
    expect(await bracketMatchId(bracket.id)).toBe(matchId);
    const [demo] = await postgres.query<Array<{ c: string }>>(
      `SELECT count(*) AS c FROM match_map_demos WHERE match_id = $1`,
      [matchId],
    );
    expect(Number(demo.c)).toBe(1);

    // The event retry keeps it.
    let retried = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      retried = await deleteTournamentMatchRows(client, t.id, true);
    });
    expect(retried.matchIds).not.toContain(matchId);
    expect(await bracketMatchId(bracket.id)).toBe(matchId);
  });

  it("the cancel locks make a demo or clip insert in flight wait for the cancel", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 9 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );

    const blocked = async (sql: string, params: unknown[]) => {
      try {
        await postgres.transaction(async (other) => {
          await other.query(`SET LOCAL lock_timeout = '300ms'`);
          await other.query(sql, params);
        });
        return "inserted";
      } catch (error) {
        return (error as Error).message;
      }
    };

    await postgres.transaction(async (client) => {
      await lockForCancel(client, [matchId]);

      expect(
        await blocked(
          `INSERT INTO match_map_demos (file, match_id, match_map_id, size)
           VALUES ($1, $2, $3, 1)`,
          [`demos/${matchId}/9.dem`, matchId, map.id],
        ),
      ).toMatch(/lock timeout/i);
      expect(
        await blocked(
          `INSERT INTO match_clips (match_map_id, file) VALUES ($1, 'clips/system/x.mp4')`,
          [map.id],
        ),
      ).toMatch(/lock timeout/i);
    });
  });

  // A render job row, as ClipsService creates them.
  const addRender = async (
    matchMapId: string,
    userSteamId: string | null,
    clipId: string | null = null,
  ) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO clip_render_jobs
         (user_steam_id, match_map_id, session_token, k8s_job_name, spec, status, clip_id)
       VALUES ($1, $2, 'token', 'job', '{}'::jsonb, $3, $4)
       RETURNING id`,
      [userSteamId, matchMapId, clipId ? "done" : "uploading", clipId],
    );
    return row.id;
  };

  it("deleting reads the files of renders that have no clip row yet", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const player = await fx.player();
    const { matchMapId, clipId } = await attachDemoAndClip(matchId, player);
    const uploading = await addRender(matchMapId, null);
    const ownerUploading = await addRender(matchMapId, player);
    await addRender(matchMapId, null, clipId); // done: its clip row has the keys

    let deleted = { matchIds: [] as string[], clipKeys: [] as string[] };
    await postgres.transaction(async (client) => {
      deleted = await deleteTournamentMatchRows(client, t.id);
    });

    expect(deleted.clipKeys.sort()).toEqual(
      [
        `clips/system/${uploading}.mp4`,
        `clips/system/${uploading}.jpg`,
        `clips/${player}/${ownerUploading}.mp4`,
        `clips/${player}/${ownerUploading}.jpg`,
      ].sort(),
    );
    const [{ c }] = await postgres.query<Array<{ c: string }>>(
      `SELECT count(*) AS c FROM clip_render_jobs WHERE match_map_id = $1`,
      [matchMapId],
    );
    expect(Number(c)).toBe(0);
  });

  // The race the API closes from both ends: the delete locks the maps before
  // reading keys, so a clip (or render) row being written waits and then
  // fails on the deleted map; ClipsService then removes the files it
  // uploaded (src/matches/clips/clips.service.spec.ts).
  it("a clip or render row written during the delete waits for it, then fails on the deleted map", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 9 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [matchId],
    );

    const write = async (sql: string, timeout = true) => {
      try {
        await postgres.transaction(async (other) => {
          if (timeout) {
            await other.query(`SET LOCAL lock_timeout = '300ms'`);
          }
          await other.query(sql, [map.id]);
        });
        return "inserted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const clipInsert = `INSERT INTO match_clips (match_map_id, file)
                        VALUES ($1, 'clips/system/late.mp4')`;
    const renderInsert = `INSERT INTO clip_render_jobs
                            (match_map_id, session_token, k8s_job_name, spec)
                          VALUES ($1, 'token', 'job', '{}'::jsonb)`;

    await postgres.transaction(async (client) => {
      await deleteTournamentMatchRows(client, t.id);
      // Still uncommitted: both writes have to wait.
      expect(await write(clipInsert)).toMatch(/lock timeout/i);
      expect(await write(renderInsert)).toMatch(/lock timeout/i);
    });

    // Committed: the map is gone, so the late rows cannot land.
    expect(await write(clipInsert, false)).toMatch(/foreign key/i);
    expect(await write(renderInsert, false)).toMatch(/foreign key/i);
  });

  it("rebuilding a bracket of only unplayed matches still works", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;

    await postgres.query(
      `SELECT public.delete_tournament_brackets_and_matches($1)`,
      [t.id],
    );

    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeUndefined();
  });

  // This is the reported production failure reproduced directly: a real,
  // fully played-out tournament (multiple rounds, multiple bracket rows)
  // deleted end to end. Before the fix, deleting matches without first
  // detaching tournament_brackets.match_id let the tournament's own cascade
  // reach a bracket row whose BEFORE DELETE trigger (tbd_tournament_brackets)
  // re-deleted an already-gone match, firing matches' AFTER DELETE trigger
  // (tad_matches -> calculate_tournament_bracket_start_times) against sibling
  // bracket rows that were simultaneously mid-cascade, raising "tuple to be
  // deleted was already modified by an operation triggered by the current
  // command". If that regressed, this call would reject with that message
  // instead of resolving.
  it("deletes a multi-round finished tournament without the tuple-modified trigger conflict", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    const brackets = await tfx.getBrackets(t.stageIds[0]);
    // Sanity: three brackets (two round-1 matches feeding one final), all
    // with a linked, now-finished match -- the exact shape that reproduced
    // the reported failure.
    expect(brackets.length).toBe(3);
    expect(brackets.every((b) => b.match_id !== null)).toBe(true);

    await expect(deleteTournamentViaTransaction(t.id)).resolves.toBeUndefined();

    expect(await tournamentExists(t.id)).toBe(false);
    for (const bracket of brackets) {
      const [match] = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM matches WHERE id = $1`,
        [bracket.match_id],
      );
      expect(match).toBeUndefined();
    }
  });

  it("detaches bracket.match_id to NULL before the match row is deleted", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    const matchId = bracket.match_id!;

    // Run only the detach step (first statement of deleteTournamentMatchRows)
    // directly, without proceeding to the match/tournament deletes.
    await postgres.transaction(async (client) => {
      await client.query(
        `WITH owned_brackets AS (
           SELECT tb.id, tb.match_id
           FROM public.tournament_brackets tb
           JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
           WHERE ts.tournament_id = $1
             AND tb.match_id IS NOT NULL
           FOR UPDATE
         ),
         detached AS (
           UPDATE public.tournament_brackets tb
           SET match_id = NULL
           FROM owned_brackets ob
           WHERE tb.id = ob.id
           RETURNING ob.match_id
         )
         SELECT DISTINCT match_id FROM detached`,
        [t.id],
      );
    });

    expect(await bracketMatchId(bracket.id)).toBeNull();
    // The match itself is untouched by the detach alone.
    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeDefined();
  });

  it("deletes match rows before the tournament row", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const matchId = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!.match_id!;

    await postgres.transaction(async (client) => {
      const { matchIds: deletedMatchIds } = await deleteTournamentMatchRows(
        client,
        t.id,
      );
      expect(deletedMatchIds).toContain(matchId);

      // At this point, mid-transaction, the match is already gone but the
      // tournament row is not -- proving the order.
      const stillThere = await client.query<{ id: string }>(
        `SELECT id FROM public.matches WHERE id = $1`,
        [matchId],
      );
      expect(stillThere.rows.length).toBe(0);

      await client.query(`DELETE FROM public.tournaments WHERE id = $1`, [
        t.id,
      ]);
    });

    expect(await tournamentExists(t.id)).toBe(false);
  });

  it("a forced failure after match deletion rolls back the bracket link, matches, awards, and the tournament together", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    const matchId = bracket.match_id!;
    const awardId = await createReusableAward(fx.nextName("Rollback Match Award"));
    const occurrenceId = await createCalculatedOccurrence(
      awardId,
      t.id,
      `calc-match-${t.id}`,
    );
    await grantToPlayer(occurrenceId, await fx.player());

    await expect(
      postgres.transaction(async (client: PoolClient) => {
        await awards.deleteTournamentAwardRecords(client, t.id);
        await deleteTournamentMatchRows(client, t.id);
        // Force a failure after the bracket detach + match row are gone but
        // before the tournament row commits.
        await client.query(`SELECT 1/0`);
      }),
    ).rejects.toThrow();

    expect(await tournamentExists(t.id)).toBe(true);
    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeDefined();
    // The detach itself rolled back too -- the bracket link is restored.
    expect(await bracketMatchId(bracket.id)).toBe(matchId);
    const [occurrence] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM award_occurrences WHERE id = $1`,
      [occurrenceId],
    );
    expect(occurrence).toBeDefined();
  });

  it("leaves another tournament's match rows and bracket links untouched", async () => {
    const target = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const other = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const otherBracket = (await tfx.getBrackets(other.stageIds[0])).find(
      (b) => b.round === 1,
    )!;

    await deleteTournamentViaTransaction(target.id);

    const [otherMatch] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [otherBracket.match_id],
    );
    expect(otherMatch).toBeDefined();
    // Other tournament's own bracket rows were never touched by target's
    // detach -- the ownership scoping (ts.tournament_id = $1) held.
    expect(await bracketMatchId(otherBracket.id)).toBe(otherBracket.match_id);
  });

  it("detaching two of this tournament's own brackets that reference the same match is safe", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const bracket = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 1,
    )!;
    const matchId = bracket.match_id!;

    // Not a shape the app produces on its own, but nothing in the schema
    // forbids two bracket rows pointing at one match -- simulate it directly.
    await postgres.query(
      `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round, match_number)
       VALUES ($1, $2, 99, 1)`,
      [t.stageIds[0], matchId],
    );

    await expect(deleteTournamentViaTransaction(t.id)).resolves.toBeUndefined();

    expect(await tournamentExists(t.id)).toBe(false);
    const [match] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(match).toBeUndefined();
  });

  it("does not delete a match still referenced by a bracket outside the tournament being deleted", async () => {
    const target = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const other = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const otherBracket = (await tfx.getBrackets(other.stageIds[0])).find(
      (b) => b.round === 1,
    )!;

    // Simulate a resolution bug by pointing one of *target*'s own brackets at
    // another tournament's live match. deleteTournamentMatchRows must detach
    // target's bracket (nulling its own match_id) but the NOT-EXISTS
    // safeguard must refuse to delete the match itself, since other's
    // bracket still references it afterward.
    const [targetStage] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM tournament_stages WHERE tournament_id = $1 LIMIT 1`,
      [target.id],
    );
    await postgres.query(
      `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round, match_number)
       VALUES ($1, $2, 1, 1)`,
      [targetStage.id, otherBracket.match_id],
    );

    await deleteTournamentViaTransaction(target.id);

    const [otherMatch] = await postgres.query<Array<{ id: string }>>(
      `SELECT id FROM matches WHERE id = $1`,
      [otherBracket.match_id],
    );
    expect(otherMatch).toBeDefined();
    expect(await tournamentExists(other.id)).toBe(true);
    expect(await bracketMatchId(otherBracket.id)).toBe(otherBracket.match_id);
  });

  it("leaves no orphaned award recipients or occurrences after deletion", async () => {
    const t = await tfx.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
    );
    const awardId = await createReusableAward(fx.nextName("Cleanup Award"));
    const calcOccurrence = await createCalculatedOccurrence(
      awardId,
      t.id,
      `calc-${t.id}`,
    );
    const manualOccurrence = await createManualOccurrence(awardId, t.id);
    await grantToPlayer(calcOccurrence, await fx.player());
    await grantToPlayer(manualOccurrence, await fx.player());

    await deleteTournamentViaTransaction(t.id);

    expect(await orphanedOccurrenceCount(t.id)).toBe(0);
    expect(await orphanedRecipientCount()).toBe(0);
  });
});
