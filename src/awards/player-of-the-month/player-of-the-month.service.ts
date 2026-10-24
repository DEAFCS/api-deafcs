import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PoolClient } from "pg";
import { PostgresService } from "../../postgres/postgres.service";
import { AwardsService } from "../awards.service";
import {
  CandidateSnapshot,
  categoryOf,
  evaluateCandidate,
  MonthMatch,
  monthRange,
  PLAYER_OF_THE_MONTH_RULES,
  PlayerRow,
  playersToCheck,
  PreviousWin,
  rankPlayerOfTheMonth,
  SanctionRow,
} from "./player-of-the-month-rules";

export const PLAYER_OF_THE_MONTH_SYSTEM_KEY = "player_of_the_month";
// Players looked up in detail (sanctions, bans, previous wins) per review.
const PLAYERS_TO_CHECK = 40;

export type ReviewView = {
  month: string;
  status: "pending" | "approved" | "rejected";
  rules_version: number;
  rules: Record<string, unknown>;
  candidates: CandidateSnapshot;
  calculated_at: string;
  calculated_by_steam_id: string | null;
  winner_steam_id: string | null;
  occurrence_id: string | null;
  decided_by_steam_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  events: Array<{ action: string; actor_steam_id: string | null; detail: unknown; created_at: string }>;
};

export const occurrenceKey = (month: string) => `${PLAYER_OF_THE_MONTH_SYSTEM_KEY}:${month}`;

// Rows of a query on the pool or on one transaction connection.
type Query = <T>(sql: string, params?: unknown[]) => Promise<T>;

// Staff review of Player of the Month. Nothing here awards anyone on its
// own: calculate() only stores the ranked candidates with their evidence;
// approve() is the one place an award is created, by an administrator, for a
// candidate of the stored snapshot, once per month (unique calculation key).
@Injectable()
export class PlayerOfTheMonthService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly awards?: AwardsService,
  ) {}

  // Only finished months can be reviewed (the whole month must be in).
  public assertReviewableMonth(month: string, now = new Date()): { start: Date; end: Date; key: string } {
    let range: { start: Date; end: Date; key: string };
    try {
      range = monthRange(month);
    } catch {
      throw new BadRequestException("Month must be YYYY-MM");
    }
    if (range.end > now) throw new BadRequestException("Only finished months can be reviewed");
    return range;
  }

  public async calculateSnapshot(month: string): Promise<CandidateSnapshot> {
    const { key } = monthRange(month);
    const query = this.poolQuery();
    const matches = await this.loadMatches(key, query);
    const ids = playersToCheck(key, matches, PLAYERS_TO_CHECK);
    if (!ids.length) {
      return rankPlayerOfTheMonth(key, matches, { players: [], sanctions: [], previousWins: [] });
    }
    return rankPlayerOfTheMonth(key, matches, await this.loadDetails(key, ids, query));
  }

  private poolQuery(): Query {
    return <T>(sql: string, params: unknown[] = []) => this.postgres.query<T>(sql, params as any);
  }

  private static clientQuery(client: PoolClient): Query {
    return async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T;
  }

  // The month's finished matches with their category and lineups.
  private async loadMatches(month: string, query: Query): Promise<MonthMatch[]> {
    const { start, end } = monthRange(month);
    const rows = await query<
      Array<{
        id: string;
        type: string;
        elo_voided: boolean | null;
        ended_at: Date | string;
        is_tournament: boolean;
        is_draft: boolean;
        has_organizer: boolean;
        rounds: number;
        lineup_1: string[];
        lineup_2: string[];
        with_stats: string[];
      }>
    >(
      `SELECT m.id,
              mo.type,
              m.elo_voided,
              m.ended_at,
              EXISTS (SELECT 1 FROM public.tournament_brackets tb WHERE tb.match_id = m.id) AS is_tournament,
              EXISTS (SELECT 1 FROM public.draft_games dg WHERE dg.match_id = m.id) AS is_draft,
              m.organizer_steam_id IS NOT NULL AS has_organizer,
              (SELECT count(*)::int
                 FROM public.match_maps mm
                 JOIN public.match_map_rounds r ON r.match_map_id = mm.id
                WHERE mm.match_id = m.id AND r.round > 0 AND r.deleted_at IS NULL) AS rounds,
              ARRAY(SELECT p.steam_id::text FROM public.match_lineup_players p
                     WHERE p.match_lineup_id = m.lineup_1_id AND p.steam_id IS NOT NULL) AS lineup_1,
              ARRAY(SELECT p.steam_id::text FROM public.match_lineup_players p
                     WHERE p.match_lineup_id = m.lineup_2_id AND p.steam_id IS NOT NULL) AS lineup_2,
              ARRAY(SELECT DISTINCT r.steam_id::text FROM public.v_player_match_rating r
                     WHERE r.match_id = m.id) AS with_stats
         FROM public.matches m
         JOIN public.match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND m.source = '5stack'
          AND m.ended_at >= $1::timestamptz
          AND m.ended_at < $2::timestamptz
          AND mo.type = ANY($3::text[])`,
      [start.toISOString(), end.toISOString(), PLAYER_OF_THE_MONTH_RULES.matchTypes],
    );

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      category: categoryOf({ isTournament: r.is_tournament, isDraft: r.is_draft, hasOrganizer: r.has_organizer }),
      eloVoided: !!r.elo_voided,
      endedAt: new Date(r.ended_at).toISOString(),
      rounds: Number(r.rounds) || 0,
      lineup1: r.lineup_1 ?? [],
      lineup2: r.lineup_2 ?? [],
      withStats: r.with_stats ?? [],
    }));
  }

  // Players, staff/system sanctions overlapping the month and earlier
  // Player of the Month wins for `ids`. Sequential: `query` may be a single
  // transaction connection.
  private async loadDetails(month: string, ids: string[], query: Query) {
    const { start, end } = monthRange(month);
    const repeatFrom = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - PLAYER_OF_THE_MONTH_RULES.repeatWindowMonths, 1),
    );
    const players = await query<
      Array<{ steam_id: string; name: string; avatar_url: string | null; country: string | null; vac_banned: boolean | null; vac_ban_count: number | null; game_ban_count: number | null }>
    >(
      `SELECT steam_id::text AS steam_id, name, avatar_url, country,
              vac_banned, vac_ban_count, game_ban_count
         FROM public.players WHERE steam_id = ANY($1::bigint[])`,
      [ids],
    );
    // Every sanction overlapping the month, removed ones included (they are
    // shown for review, never applied silently).
    const sanctions = await query<
      Array<{ steam_id: string; type: string; created_at: Date; remove_sanction_date: Date | null; deleted_at: Date | null; reason: string | null; system: boolean }>
    >(
      `SELECT player_steam_id::text AS steam_id, type, created_at, remove_sanction_date,
              deleted_at, reason, sanctioned_by_steam_id IS NULL AS system
         FROM public.player_sanctions
        WHERE player_steam_id = ANY($1::bigint[])
          AND created_at < $3::timestamptz
          AND (remove_sanction_date IS NULL OR remove_sanction_date > $2::timestamptz)
        ORDER BY created_at`,
      [ids, start.toISOString(), end.toISOString()],
    );
    const wins = await query<Array<{ steam_id: string; effective_at: Date }>>(
      `SELECT r.player_steam_id::text AS steam_id, o.effective_at
         FROM public.award_recipients r
         JOIN public.award_occurrences o ON o.id = r.occurrence_id
         JOIN public.awards a ON a.id = o.award_id
        WHERE a.system_key = $4
          AND r.revoked_at IS NULL
          AND r.player_steam_id = ANY($1::bigint[])
          AND o.effective_at >= $2::timestamptz
          AND o.effective_at < $3::timestamptz`,
      [ids, repeatFrom.toISOString(), start.toISOString(), PLAYER_OF_THE_MONTH_SYSTEM_KEY],
    );

    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    return {
      players: players.map<PlayerRow>((p) => ({
        steamId: p.steam_id,
        name: p.name,
        avatarUrl: p.avatar_url,
        country: p.country,
        vacBanned: !!p.vac_banned,
        vacBanCount: Number(p.vac_ban_count) || 0,
        gameBanCount: Number(p.game_ban_count) || 0,
      })),
      sanctions: sanctions.map<SanctionRow>((s) => ({
        steamId: s.steam_id,
        type: s.type,
        createdAt: iso(s.created_at) as string,
        removeSanctionDate: iso(s.remove_sanction_date),
        deletedAt: iso(s.deleted_at),
        reason: s.reason,
        system: !!s.system,
      })),
      previousWins: wins.map<PreviousWin>((w) => ({
        steamId: w.steam_id,
        month: new Date(w.effective_at).toISOString().slice(0, 7),
      })),
    };
  }

  // Store (or refresh) the month's candidates. Idempotent: the same data
  // gives the same snapshot. An approved month is final and is not touched;
  // a rejected one goes back to pending with the fresh snapshot.
  public async calculate(month: string, actorSteamId: string): Promise<ReviewView> {
    const { start, key } = this.assertReviewableMonth(month);
    const snapshot = await this.calculateSnapshot(key);
    const monthDate = start.toISOString().slice(0, 10);

    await this.postgres.transaction(async (client) => {
      const existing = await client.query<{ status: string }>(
        `SELECT status FROM public.player_of_the_month_reviews WHERE month = $1 FOR UPDATE`,
        [monthDate],
      );
      if (existing.rows[0]?.status === "approved") {
        throw new ConflictException("This month is already approved");
      }
      await client.query(
        `INSERT INTO public.player_of_the_month_reviews
           (month, status, rules_version, rules, candidates, calculated_at, calculated_by_steam_id)
         VALUES ($1, 'pending', $2, $3::jsonb, $4::jsonb, now(), $5)
         ON CONFLICT (month) DO UPDATE
           SET status = 'pending',
               rules_version = EXCLUDED.rules_version,
               rules = EXCLUDED.rules,
               candidates = EXCLUDED.candidates,
               calculated_at = EXCLUDED.calculated_at,
               calculated_by_steam_id = EXCLUDED.calculated_by_steam_id,
               decided_by_steam_id = NULL,
               decided_at = NULL,
               decision_note = NULL,
               updated_at = now()`,
        [
          monthDate,
          snapshot.rulesVersion,
          JSON.stringify(PLAYER_OF_THE_MONTH_RULES),
          JSON.stringify(snapshot),
          actorSteamId,
        ],
      );
      await client.query(
        `INSERT INTO public.player_of_the_month_review_events (month, action, actor_steam_id, detail)
         VALUES ($1, 'calculated', $2, $3::jsonb)`,
        [
          monthDate,
          actorSteamId,
          JSON.stringify({
            rulesVersion: snapshot.rulesVersion,
            recommendedSteamId: snapshot.recommendedSteamId,
            candidates: snapshot.candidates.length,
            top: snapshot.candidates.slice(0, 3).map((c) => ({
              steamId: c.steamId,
              eligibleMatches: c.eligibleMatches,
              eligible: c.eligible,
            })),
          }),
        ],
      );
    });
    return this.getReview(key) as Promise<ReviewView>;
  }

  // Award the month to a candidate of the stored snapshot. The award is an
  // ordinary manual occurrence (revocable by staff, permanent history);
  // calculation_key makes a second award for the same month impossible.
  //
  // The snapshot can be old by the time staff approve, so the chosen player
  // is rechecked inside the transaction on current data (matches, staff
  // sanctions, earlier wins) and refused if no longer eligible. The player's
  // row is locked first: inserting a sanction (or an award recipient) takes
  // a key-share lock on that row, so a sanction written concurrently either
  // commits before the recheck reads (and is seen) or waits until the award
  // is committed (and was issued after the decision).
  public async approve(month: string, playerSteamId: string, note: string | null, actorSteamId: string): Promise<ReviewView> {
    const { start, key } = this.assertReviewableMonth(month);
    if (!/^\d{1,20}$/.test(playerSteamId ?? "")) throw new BadRequestException("Invalid player");
    const monthDate = start.toISOString().slice(0, 10);

    let occurrenceId: string | null = null;
    await this.postgres.transaction(async (client) => {
      const review = await client.query<{ status: string; candidates: CandidateSnapshot }>(
        `SELECT status, candidates FROM public.player_of_the_month_reviews WHERE month = $1 FOR UPDATE`,
        [monthDate],
      );
      const row = review.rows[0];
      if (!row) throw new NotFoundException("Calculate the month first");
      if (row.status !== "pending") throw new ConflictException(`This month is already ${row.status}`);
      const candidate = row.candidates?.candidates?.find((c) => c.steamId === playerSteamId);
      if (!candidate) throw new BadRequestException("Not a candidate of this month's review");
      if (!candidate.eligible) {
        throw new BadRequestException(`Not eligible: ${candidate.disqualifiedBy.join(", ")}`);
      }

      const locked = await client.query(`SELECT 1 FROM public.players WHERE steam_id = $1::bigint FOR UPDATE`, [
        playerSteamId,
      ]);
      if (!locked.rows[0]) throw new BadRequestException("Player not found");
      const query = PlayerOfTheMonthService.clientQuery(client);
      const current = evaluateCandidate(
        key,
        await this.loadMatches(key, query),
        await this.loadDetails(key, [playerSteamId], query),
        playerSteamId,
      );
      if (!current?.eligible) {
        throw new BadRequestException(
          `No longer eligible: ${current?.disqualifiedBy.join(", ") || "no counted match in the month"}. Recalculate the month.`,
        );
      }

      const award = await client.query<{ id: string }>(
        `SELECT id FROM public.awards WHERE system_key = $1 AND archived_at IS NULL`,
        [PLAYER_OF_THE_MONTH_SYSTEM_KEY],
      );
      if (!award.rows[0]) throw new NotFoundException("Player of the Month award is missing or archived");

      const occurrence = await client.query<{ id: string }>(
        `INSERT INTO public.award_occurrences (award_id, source, effective_at, note, awarded_by, calculation_key)
         VALUES ($1, 'manual', $2::timestamptz, $3, $4, $5)
         ON CONFLICT (calculation_key) DO NOTHING
         RETURNING id`,
        [award.rows[0].id, start.toISOString(), note, actorSteamId, occurrenceKey(key)],
      );
      if (!occurrence.rows[0]) throw new ConflictException("This month already has a Player of the Month");
      occurrenceId = occurrence.rows[0].id;

      await client.query(
        `INSERT INTO public.award_recipients (occurrence_id, player_steam_id, recipient_note)
         VALUES ($1, $2, $3)`,
        [occurrence.rows[0].id, playerSteamId, note],
      );
      await client.query(
        `UPDATE public.player_of_the_month_reviews
            SET status = 'approved', winner_steam_id = $2, occurrence_id = $3,
                decided_by_steam_id = $4, decided_at = now(), decision_note = $5, updated_at = now()
          WHERE month = $1`,
        [monthDate, playerSteamId, occurrence.rows[0].id, actorSteamId, note],
      );
      await client.query(
        `INSERT INTO public.player_of_the_month_review_events (month, action, actor_steam_id, detail)
         VALUES ($1, 'approved', $2, $3::jsonb)`,
        [
          monthDate,
          actorSteamId,
          JSON.stringify({
            winnerSteamId: playerSteamId,
            occurrenceId: occurrence.rows[0].id,
            recommended: row.candidates.recommendedSteamId === playerSteamId,
            eligibleMatches: candidate.eligibleMatches,
            // As rechecked at approval time.
            current: { eligibleMatches: current.eligibleMatches, roundsPlayed: current.roundsPlayed, flags: current.flags },
            flags: candidate.flags,
            note,
          }),
        ],
      );
    });
    // After the commit; a failed notification never undoes the approval.
    if (occurrenceId) void this.awards?.notifyAwarded(occurrenceId);
    return this.getReview(key) as Promise<ReviewView>;
  }

  // No winner for the month (e.g. the evidence does not hold up). It can be
  // recalculated later, which puts it back to pending.
  public async reject(month: string, note: string, actorSteamId: string): Promise<ReviewView> {
    const { start, key } = this.assertReviewableMonth(month);
    if (!note?.trim()) throw new BadRequestException("A reason is required");
    const monthDate = start.toISOString().slice(0, 10);
    await this.postgres.transaction(async (client) => {
      const review = await client.query<{ status: string }>(
        `SELECT status FROM public.player_of_the_month_reviews WHERE month = $1 FOR UPDATE`,
        [monthDate],
      );
      if (!review.rows[0]) throw new NotFoundException("Calculate the month first");
      if (review.rows[0].status !== "pending") {
        throw new ConflictException(`This month is already ${review.rows[0].status}`);
      }
      await client.query(
        `UPDATE public.player_of_the_month_reviews
            SET status = 'rejected', decided_by_steam_id = $2, decided_at = now(),
                decision_note = $3, updated_at = now()
          WHERE month = $1`,
        [monthDate, actorSteamId, note.trim()],
      );
      await client.query(
        `INSERT INTO public.player_of_the_month_review_events (month, action, actor_steam_id, detail)
         VALUES ($1, 'rejected', $2, $3::jsonb)`,
        [monthDate, actorSteamId, JSON.stringify({ note: note.trim() })],
      );
    });
    return this.getReview(key) as Promise<ReviewView>;
  }

  public async getReview(month: string): Promise<ReviewView | null> {
    const { start, key } = monthRange(month);
    const monthDate = start.toISOString().slice(0, 10);
    const [review] = await this.postgres.query<
      Array<{
        status: ReviewView["status"];
        rules_version: number;
        rules: Record<string, unknown>;
        candidates: CandidateSnapshot;
        calculated_at: Date;
        calculated_by_steam_id: string | null;
        winner_steam_id: string | null;
        occurrence_id: string | null;
        decided_by_steam_id: string | null;
        decided_at: Date | null;
        decision_note: string | null;
      }>
    >(
      `SELECT status, rules_version, rules, candidates, calculated_at,
              calculated_by_steam_id::text AS calculated_by_steam_id,
              winner_steam_id::text AS winner_steam_id, occurrence_id,
              decided_by_steam_id::text AS decided_by_steam_id, decided_at, decision_note
         FROM public.player_of_the_month_reviews WHERE month = $1`,
      [monthDate],
    );
    if (!review) return null;
    const events = await this.postgres.query<
      Array<{ action: string; actor_steam_id: string | null; detail: unknown; created_at: Date }>
    >(
      `SELECT action, actor_steam_id::text AS actor_steam_id, detail, created_at
         FROM public.player_of_the_month_review_events WHERE month = $1 ORDER BY created_at, id`,
      [monthDate],
    );
    return {
      month: key,
      ...review,
      calculated_at: new Date(review.calculated_at).toISOString(),
      decided_at: review.decided_at ? new Date(review.decided_at).toISOString() : null,
      events: events.map((e) => ({ ...e, created_at: new Date(e.created_at).toISOString() })),
    };
  }
}
