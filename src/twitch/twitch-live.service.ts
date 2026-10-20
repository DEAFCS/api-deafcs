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
// - Everyone gets the same list, including players in an ongoing match:
//   players manage their own Twitch stream delay (TricoN, 2026-10-20). The
//   anti-cheat rule of DEAFCS-controlled viewing (/twitch/match-streams and
//   the match page) is separate and unchanged.

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

export const MAX_LIVE_STREAMERS = 24;

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

  public async getLiveStreamers(): Promise<LiveStreamersResponse> {
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

    return {
      available: result.value.available,
      checkedAt: result.generatedAt,
      streams: result.value.streams,
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
}
