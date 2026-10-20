import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { staleWhileRevalidate } from "../cache/stale-while-revalidate";
import { PostgresService } from "../postgres/postgres.service";
import { isCounterStrikeStream, TwitchChannelStatus, TwitchService } from "./twitch.service";
import { twitchChannelUrl } from "./twitch-channel";

// Every DEAFCS player with a linked Twitch channel who is live in
// Counter-Strike right now (homepage "Live on Twitch"). No staff approval:
// a linked channel + live + CS category is enough.
//
// - The channel list is read from players.twitch_channel on every refresh,
//   so unlinking (PUT /twitch/me with null) drops a player at the next one.
// - Players with an active ban are never promoted.
// - Twitch status comes from TwitchService (server-side app token, batched
//   Helix calls of 100, per-channel cache); the browser never talks to
//   Twitch for this and never sees credentials.
// - The list itself is one shared Redis entry, fresh for LIST_FRESH_SECONDS,
//   refreshed by a single caller at a time (stale-while-revalidate).
// - Anti-cheat, same rule as /twitch/match-streams: a signed-in viewer never
//   gets the streams of players in a match they play or coach right now.

export type LiveStreamer = {
  steamId: string;
  playerName: string;
  avatarUrl: string | null;
  channel: string;
  link: string;
  title: string | null;
  viewerCount: number | null;
  startedAt: string | null;
  thumbnailUrl: string | null;
};

export type LiveStreamersResponse = {
  // false when Twitch could not be asked (no credentials, Twitch down):
  // the homepage just hides the section.
  available: boolean;
  checkedAt: string | null;
  streams: LiveStreamer[];
};

type LiveList = { available: boolean; streams: LiveStreamer[] };

// Matches still in progress for anti-cheat purposes (pre-match included:
// knowing an opponent's screen before the server starts is not harmless).
export const VIEWER_ACTIVE_MATCH_STATUSES = [
  "Live",
  "Veto",
  "WaitingForCheckIn",
  "WaitingForServer",
  "PickingPlayers",
];
export const MAX_LIVE_STREAMERS = 24;
const STEAM_ID_RE = /^\d{1,20}$/;

@Injectable()
export class TwitchLiveService {
  public static readonly CACHE_KEY = "twitch:live:v1";
  public static readonly LIST_FRESH_SECONDS = 60;
  public static readonly LIST_KEEP_SECONDS = 300;

  constructor(
    private readonly postgres: PostgresService,
    private readonly twitch: TwitchService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
  ) {}

  public async getLiveStreamers(viewerSteamId: string | null): Promise<LiveStreamersResponse> {
    const result = await staleWhileRevalidate<LiveList>(
      this.cache,
      TwitchLiveService.CACHE_KEY,
      {
        freshSeconds: TwitchLiveService.LIST_FRESH_SECONDS,
        keepSeconds: TwitchLiveService.LIST_KEEP_SECONDS,
        lockSeconds: 30,
        waitMs: 3_000,
      },
      () => this.computeLiveList(),
      (error) => this.logger.warn(`[twitch] live list refresh failed: ${(error as Error)?.message}`),
    );
    if (result.status === "unavailable") {
      return { available: false, checkedAt: null, streams: [] };
    }

    const hidden = await this.playersInViewerMatches(viewerSteamId);
    return {
      available: result.value.available,
      checkedAt: result.generatedAt,
      streams: result.value.streams.filter((s) => !hidden.has(s.steamId)),
    };
  }

  public async computeLiveList(): Promise<LiveList> {
    const linked = await this.postgres.query<
      Array<{ steam_id: string; name: string; avatar_url: string | null; twitch_channel: string }>
    >(
      `SELECT p.steam_id::text AS steam_id, p.name, p.avatar_url, p.twitch_channel
         FROM public.players p
        WHERE p.twitch_channel IS NOT NULL
          AND public.is_banned(p) IS NOT TRUE`,
    );
    if (!linked.length) return { available: true, streams: [] };

    const statuses: Record<string, TwitchChannelStatus> = await this.twitch.getStatuses(
      linked.map((row) => row.twitch_channel),
    );
    const available = Object.values(statuses).some((s) => s.available);

    const seen = new Set<string>();
    const streams: LiveStreamer[] = [];
    for (const row of linked) {
      const status = statuses[row.twitch_channel];
      if (!status || !isCounterStrikeStream(status) || seen.has(row.twitch_channel)) continue;
      seen.add(row.twitch_channel);
      streams.push({
        steamId: row.steam_id,
        playerName: row.name,
        avatarUrl: row.avatar_url,
        channel: row.twitch_channel,
        link: twitchChannelUrl(row.twitch_channel),
        title: status.title,
        viewerCount: status.viewerCount ?? null,
        startedAt: status.startedAt ?? null,
        thumbnailUrl: status.thumbnailUrl ?? null,
      });
    }

    streams.sort(
      (a, b) =>
        (b.viewerCount ?? -1) - (a.viewerCount ?? -1) ||
        a.playerName.localeCompare(b.playerName) ||
        a.steamId.localeCompare(b.steamId),
    );
    return { available, streams: streams.slice(0, MAX_LIVE_STREAMERS) };
  }

  // Everyone seated in a match the viewer plays or coaches that is still in
  // progress: their streams are not offered to this viewer.
  private async playersInViewerMatches(viewerSteamId: string | null): Promise<Set<string>> {
    if (!viewerSteamId || !STEAM_ID_RE.test(viewerSteamId)) return new Set();
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT other.steam_id::text AS steam_id
         FROM public.matches m
         JOIN public.match_lineup_players other
           ON other.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
        WHERE m.status = ANY($2::text[])
          AND other.steam_id IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM public.match_lineup_players mine
               WHERE mine.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                 AND mine.steam_id = $1::bigint
            )
            OR EXISTS (
              SELECT 1 FROM public.match_lineups ml
               WHERE ml.match_id = m.id
                 AND ml.coach_steam_id = $1::bigint
            )
          )`,
      [viewerSteamId, VIEWER_ACTIVE_MATCH_STATUSES],
    );
    return new Set(rows.map((row) => row.steam_id));
  }
}
