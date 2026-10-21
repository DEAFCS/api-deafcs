import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { staleWhileRevalidate } from "../cache/stale-while-revalidate";
import { PostgresService } from "../postgres/postgres.service";
import {
  ClutchRow,
  OpeningRow,
  RatingRow,
  StatsRow,
  weeklyRecords,
  WeeklyRecord,
} from "./weekly-records";

// Server-side "Last 7 Days" for the homepage: the same rows the browser reads
// through Hasura (guest permissions on these sources have no row filter, and
// a Finished non-practice match is visible to guests), the same calculation
// (weekly-records.ts, a 1:1 port), computed once per freshness window for
// everyone and shared through Redis.
//
// Freshness: 5 minutes, then stale-while-revalidate for up to 30 minutes.
// No scheduled warmer: the first visitor after a quiet period pays one
// computation (~3 s), everyone else reads Redis; a recurring job would run
// the expensive views even when nobody is looking.

export const WEEKLY_RECORD_MODES = ["Competitive"] as const;
export type WeeklyRecordMode = (typeof WEEKLY_RECORD_MODES)[number];

export type WeeklyRecordsPlayer = {
  name: string;
  avatar_url: string | null;
  country: string | null;
};

export type WeeklyRecordsPayload = {
  mode: WeeklyRecordMode;
  windowStart: string;
  windowEnd: string;
  matchCount: number;
  records: WeeklyRecord[];
  players: Record<string, WeeklyRecordsPlayer>;
};

export type WeeklyRecordsResponse =
  | (WeeklyRecordsPayload & { available: true; generatedAt: string })
  | { available: false; mode: WeeklyRecordMode };

const WINDOW_MS = 7 * 86_400_000;
const MAX_MATCHES = 500;

@Injectable()
export class WeeklyRecordsService {
  public static readonly FRESH_SECONDS = 300;
  public static readonly KEEP_SECONDS = 1800;
  public static readonly LOCK_SECONDS = 60;
  public static readonly COLD_WAIT_MS = 8_000;

  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
  ) {}

  public static cacheKey(mode: WeeklyRecordMode) {
    return `stats:weekly-records:v1:${mode}`;
  }

  public async get(mode: WeeklyRecordMode): Promise<WeeklyRecordsResponse> {
    const result = await staleWhileRevalidate(
      this.cache,
      WeeklyRecordsService.cacheKey(mode),
      {
        freshSeconds: WeeklyRecordsService.FRESH_SECONDS,
        keepSeconds: WeeklyRecordsService.KEEP_SECONDS,
        lockSeconds: WeeklyRecordsService.LOCK_SECONDS,
        waitMs: WeeklyRecordsService.COLD_WAIT_MS,
      },
      () => this.compute(mode),
      (error) =>
        this.logger.warn(`[stats] weekly records refresh failed: ${(error as Error)?.message}`),
    );
    if (result.status === "unavailable") return { available: false, mode };
    return { ...result.value, available: true, generatedAt: result.generatedAt };
  }

  public async compute(mode: WeeklyRecordMode, now = new Date()): Promise<WeeklyRecordsPayload> {
    const windowEnd = now.toISOString();
    const windowStart = new Date(now.getTime() - WINDOW_MS).toISOString();

    const matches = await this.postgres.query<
      Array<{ id: string; mr: number | null; seated_1: number; seated_2: number }>
    >(
      `SELECT m.id,
              mo.mr,
              (SELECT count(*)::int FROM public.match_lineup_players p
                WHERE p.match_lineup_id = m.lineup_1_id AND p.steam_id IS NOT NULL) AS seated_1,
              (SELECT count(*)::int FROM public.match_lineup_players p
                WHERE p.match_lineup_id = m.lineup_2_id AND p.steam_id IS NOT NULL) AS seated_2
         FROM public.matches m
         JOIN public.match_options mo ON mo.id = m.match_options_id
        WHERE m.status = 'Finished'
          AND m.source = '5stack'
          AND m.ended_at >= $1::timestamptz
          AND mo.type = $2
        ORDER BY m.ended_at DESC
        LIMIT ${MAX_MATCHES}`,
      [windowStart, mode],
    );

    const empty: WeeklyRecordsPayload = {
      mode,
      windowStart,
      windowEnd,
      matchCount: matches.length,
      records: [],
      players: {},
    };
    if (!matches.length) return empty;

    const ids = matches.map((m) => m.id);
    // Clutches only in true 5v5 matches (the clutch detector treats every
    // seated player as alive at round start).
    const clutchIds = matches.filter((m) => m.seated_1 === 5 && m.seated_2 === 5).map((m) => m.id);

    const [ratings, stats, clutches, openings] = await Promise.all([
      this.postgres.query<RatingRow[]>(
        `SELECT steam_id::text AS steam_id, match_id, adr, hltv_rating, rounds_played
           FROM public.v_player_match_rating
          WHERE match_id = ANY($1::uuid[])`,
        [ids],
      ),
      this.postgres.query<StatsRow[]>(
        `SELECT steam_id::text AS steam_id, match_id, kills, hs_kills, deaths
           FROM public.player_match_stats_v
          WHERE match_id = ANY($1::uuid[])`,
        [ids],
      ),
      clutchIds.length
        ? this.postgres.query<ClutchRow[]>(
            `SELECT match_id, clutcher_steam_id::text AS clutcher_steam_id
               FROM public.v_match_clutches
              WHERE match_id = ANY($1::uuid[]) AND outcome = 'won'`,
            [clutchIds],
          )
        : Promise.resolve([] as ClutchRow[]),
      this.postgres.query<OpeningRow[]>(
        `SELECT match_id, steam_id::text AS steam_id, wins
           FROM public.v_match_player_opening_duels
          WHERE match_id = ANY($1::uuid[]) AND wins > 0`,
        [ids],
      ),
    ]);

    const mr = Object.fromEntries(matches.map((m) => [m.id, m.mr]));
    const records = weeklyRecords(ratings, stats, mr, { clutches, openings });

    const steamIds = [...new Set(records.flatMap((r) => r.entries.map((e) => e.steamId)))];
    const players: Record<string, WeeklyRecordsPlayer> = {};
    if (steamIds.length) {
      const rows = await this.postgres.query<
        Array<{ steam_id: string; name: string; avatar_url: string | null; country: string | null }>
      >(
        `SELECT steam_id::text AS steam_id, name, avatar_url, country
           FROM public.players
          WHERE steam_id = ANY($1::bigint[])`,
        [steamIds],
      );
      for (const row of rows) {
        players[row.steam_id] = { name: row.name, avatar_url: row.avatar_url, country: row.country };
      }
    }

    return { ...empty, records, players };
  }
}
