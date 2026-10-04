import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { TwitchConfig } from "../configs/types/TwitchConfig";
import { TWITCH_LOGIN_PATTERN } from "./twitch-channel";

// Public, credential-free view of one channel's live state.
export type TwitchChannelStatus = {
  channel: string;
  live: boolean;
  // false when Twitch could not be asked (no credentials, Twitch error):
  // callers show "not live" rather than guessing.
  available: boolean;
  streamId: string | null;
  gameId: string | null;
  gameName: string | null;
  title: string | null;
  checkedAt: string;
};

type HelixStream = {
  id: string;
  user_login: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
};

// Twitch's "Counter-Strike" category (CS2 took over the former CS:GO
// category id). The name check covers a possible separate "Counter-Strike 2"
// listing without guessing an id for it.
export const TWITCH_COUNTER_STRIKE_GAME_ID = "32399";
const COUNTER_STRIKE_NAMES = new Set(["counter-strike", "counter-strike 2"]);

export function isCounterStrikeStream(status: TwitchChannelStatus): boolean {
  if (!status.live) return false;
  if (status.gameId === TWITCH_COUNTER_STRIKE_GAME_ID) return true;
  return COUNTER_STRIKE_NAMES.has((status.gameName ?? "").trim().toLowerCase());
}

// Server-side Twitch live status (Helix, app access token). Browsers never
// talk to Twitch for this and never see the credentials or the token.
// Every channel's answer is cached for STATUS_TTL_SECONDS and lookups are
// batched, so profile views and match pages don't hammer Twitch.
@Injectable()
export class TwitchService {
  public static readonly STATUS_TTL_SECONDS = 45;
  public static readonly ERROR_TTL_SECONDS = 15;
  public static readonly MAX_CHANNELS_PER_REQUEST = 100;
  private static readonly TOKEN_URL = "https://id.twitch.tv/oauth2/token";
  private static readonly STREAMS_URL = "https://api.twitch.tv/helix/streams";
  private static readonly TIMEOUT_MS = 8_000;

  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string | null> | null = null;

  constructor(
    config: ConfigService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
  ) {
    const twitch = config.get<TwitchConfig>("twitch") ?? {};
    this.clientId = twitch.clientId || undefined;
    this.clientSecret = twitch.clientSecret || undefined;
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  public static cacheKey(channel: string) {
    return `twitch:status:${channel}`;
  }

  // Live status for each channel (normalized logins; anything else is
  // ignored). Cached answers are reused; the rest go to Twitch in one call.
  public async getStatuses(
    channels: string[],
  ): Promise<Record<string, TwitchChannelStatus>> {
    const wanted = [
      ...new Set(
        channels
          .map((c) => (c ?? "").trim().toLowerCase())
          .filter((c) => TWITCH_LOGIN_PATTERN.test(c)),
      ),
    ];
    const result: Record<string, TwitchChannelStatus> = {};
    const missing: string[] = [];

    for (const channel of wanted) {
      const cached = (await this.cache.get(
        TwitchService.cacheKey(channel),
      )) as TwitchChannelStatus | undefined;
      if (cached) result[channel] = cached;
      else missing.push(channel);
    }

    for (let i = 0; i < missing.length; i += TwitchService.MAX_CHANNELS_PER_REQUEST) {
      const batch = missing.slice(i, i + TwitchService.MAX_CHANNELS_PER_REQUEST);
      Object.assign(result, await this.fetchStatuses(batch));
    }
    return result;
  }

  public async getStatus(channel: string): Promise<TwitchChannelStatus | null> {
    const statuses = await this.getStatuses([channel]);
    return statuses[channel.toLowerCase()] ?? null;
  }

  private unavailable(channel: string, checkedAt: string): TwitchChannelStatus {
    return {
      channel,
      live: false,
      available: false,
      streamId: null,
      gameId: null,
      gameName: null,
      title: null,
      checkedAt,
    };
  }

  private async fetchStatuses(
    channels: string[],
  ): Promise<Record<string, TwitchChannelStatus>> {
    const checkedAt = new Date().toISOString();
    const unavailable = () =>
      Object.fromEntries(channels.map((c) => [c, this.unavailable(c, checkedAt)]));

    // Not configured: report unavailable, but don't cache it, so adding the
    // credentials takes effect immediately.
    if (!this.isConfigured() || channels.length === 0) return unavailable();

    let streams = await this.requestStreams(channels);
    if (streams === "unauthorized") {
      this.token = null;
      streams = await this.requestStreams(channels);
    }

    if (!Array.isArray(streams)) {
      const result = unavailable();
      for (const status of Object.values(result)) {
        await this.cache.put(
          TwitchService.cacheKey(status.channel),
          status,
          TwitchService.ERROR_TTL_SECONDS,
        );
      }
      return result;
    }

    const byLogin = new Map(
      streams
        .filter((s) => s.type === "live")
        .map((s) => [s.user_login.toLowerCase(), s]),
    );
    const result: Record<string, TwitchChannelStatus> = {};
    for (const channel of channels) {
      const stream = byLogin.get(channel);
      const status: TwitchChannelStatus = stream
        ? {
            channel,
            live: true,
            available: true,
            streamId: stream.id,
            gameId: stream.game_id || null,
            gameName: stream.game_name || null,
            title: stream.title || null,
            checkedAt,
          }
        : { ...this.unavailable(channel, checkedAt), available: true };
      result[channel] = status;
      await this.cache.put(
        TwitchService.cacheKey(channel),
        status,
        TwitchService.STATUS_TTL_SECONDS,
      );
    }
    return result;
  }

  private async requestStreams(
    channels: string[],
  ): Promise<HelixStream[] | "unauthorized" | "error"> {
    const token = await this.getAppToken();
    if (!token) return "error";

    const query = channels
      .map((c) => `user_login=${encodeURIComponent(c)}`)
      .join("&");
    try {
      const response = await fetch(`${TwitchService.STREAMS_URL}?${query}&first=100`, {
        headers: {
          "Client-Id": this.clientId as string,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(TwitchService.TIMEOUT_MS),
      });
      if (response.status === 401) return "unauthorized";
      if (!response.ok) {
        this.logger.warn(`[twitch] streams request failed: ${response.status}`);
        return "error";
      }
      const body = (await response.json()) as { data?: HelixStream[] };
      return Array.isArray(body?.data) ? body.data : [];
    } catch (error) {
      this.logger.warn(`[twitch] streams request errored: ${(error as Error)?.name ?? "error"}`);
      return "error";
    }
  }

  // App access token (client credentials), kept in memory until shortly
  // before it expires. Concurrent callers share one token request.
  private async getAppToken(): Promise<string | null> {
    if (!this.isConfigured()) return null;
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestAppToken().finally(() => {
        this.tokenRequest = null;
      });
    }
    return this.tokenRequest;
  }

  private async requestAppToken(): Promise<string | null> {
    try {
      const body = new URLSearchParams({
        client_id: this.clientId as string,
        client_secret: this.clientSecret as string,
        grant_type: "client_credentials",
      });
      const response = await fetch(TwitchService.TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TwitchService.TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`[twitch] app token request failed: ${response.status}`);
        return null;
      }
      const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!data?.access_token) return null;
      const lifetimeMs = Math.max(60, Number(data.expires_in) || 3600) * 1000;
      this.token = {
        value: data.access_token,
        // Renew a minute early.
        expiresAt: Date.now() + lifetimeMs - 60_000,
      };
      return this.token.value;
    } catch (error) {
      this.logger.warn(`[twitch] app token request errored: ${(error as Error)?.name ?? "error"}`);
      return null;
    }
  }
}
