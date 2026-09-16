import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";

export type FaceitPlayerData = {
  faceit_player_id: string;
  faceit_nickname: string;
  faceit_url: string | null;
  faceit_skill_level: number | null;
  faceit_elo: number | null;
};

type FaceitPlayerLookup =
  | { status: "ok"; data: FaceitPlayerData }
  | { status: "not_found" }
  | { status: "unavailable" };

type FaceitHistoryItem = {
  match_id?: string;
  finished_at?: number;
  status?: string;
};

export function latestCompletedFaceitMatchAt(
  items: FaceitHistoryItem[],
): string | null {
  const latestSeconds = items.reduce<number | null>((latest, item) => {
    if (
      !item.finished_at ||
      (item.status && item.status.toUpperCase() !== "FINISHED")
    ) {
      return latest;
    }
    return latest == null || item.finished_at > latest
      ? item.finished_at
      : latest;
  }, null);

  return latestSeconds == null
    ? null
    : new Date(latestSeconds * 1000).toISOString();
}

@Injectable()
export class FaceitService {
  private static readonly BASE_URL = "https://open.faceit.com/data/v4";
  private static readonly REFRESH_INTERVAL_SECONDS = 60 * 60;
  private static readonly NO_ACCOUNT_TTL_SECONDS = 12 * 60 * 60;
  private static readonly LEADERBOARD_STALE_HOURS = 6;
  private static readonly LEADERBOARD_FAILED_RETRY_MINUTES = 45;
  private static readonly LEADERBOARD_REFRESH_LIMIT = 100;
  private static readonly LEADERBOARD_REFRESH_CONCURRENCY = 2;
  private static readonly VERIFIED_ROLES = [
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];
  private readonly apiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly logger: Logger,
  ) {
    this.apiKey = this.config.get("faceit.apiKey");
  }

  public isEnabled(): boolean {
    return !!this.apiKey;
  }

  public async testIntegration(steamId?: string): Promise<{
    dataApi: { ok: boolean; detail: string };
    downloadApi: { ok: boolean | null; detail: string };
  }> {
    if (!this.apiKey) {
      const detail = "FACEIT_API_KEY not configured";
      return {
        dataApi: { ok: false, detail },
        downloadApi: { ok: false, detail },
      };
    }

    let dataApi: { ok: boolean; detail: string };
    try {
      const res = await fetch(`${FaceitService.BASE_URL}/games/cs2`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      dataApi = res.ok
        ? { ok: true, detail: "Data API authorized (ranks/match metadata)" }
        : { ok: false, detail: `Data API responded ${res.status}` };
    } catch (error) {
      dataApi = {
        ok: false,
        detail: `Data API error: ${(error as Error)?.message ?? "unknown"}`,
      };
    }

    const resourceUrl = await this.findTestableDemoUrl(steamId);
    let downloadApi: { ok: boolean | null; detail: string };
    if (!resourceUrl) {
      downloadApi = {
        ok: null,
        detail:
          "Not tested — no recent Faceit demo on your account to sign. Demo import still requires Downloads API access.",
      };
    } else {
      try {
        const res = await fetch(
          "https://open.faceit.com/download/v2/demos/download",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ resource_url: resourceUrl }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.status === 403) {
          downloadApi = {
            ok: false,
            detail:
              "Downloads API not authorized — apply at https://fce.gg/downloads-api-application",
          };
        } else if (res.ok) {
          downloadApi = {
            ok: true,
            detail: "Downloads API authorized (signed a real demo)",
          };
        } else {
          downloadApi = {
            ok: false,
            detail: `Downloads API responded ${res.status}`,
          };
        }
      } catch (error) {
        downloadApi = {
          ok: false,
          detail: `Downloads API error: ${(error as Error)?.message ?? "unknown"}`,
        };
      }
    }

    return { dataApi, downloadApi };
  }

  private async findTestableDemoUrl(steamId?: string): Promise<string | null> {
    if (!steamId) {
      return null;
    }
    const playerId = await this.resolvePlayerId(steamId);
    if (!playerId) {
      return null;
    }
    const matches = await this.getRecentMatches(playerId, { limit: 5 });
    for (const match of matches) {
      const { demoUrl } = await this.getMatchDemo(match.matchId);
      if (demoUrl) {
        return demoUrl;
      }
    }
    return null;
  }

  public async signDownloadUrl(resourceUrl: string): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }
    try {
      const response = await fetch(
        "https://open.faceit.com/download/v2/demos/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ resource_url: resourceUrl }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        this.logger.error(
          `faceit downloads api ${response.status} for ${resourceUrl}`,
        );
        return null;
      }
      const data = (await response.json()) as {
        payload?: { download_url?: string };
      };
      return data.payload?.download_url ?? null;
    } catch (error) {
      this.logger.error(
        `faceit downloads api failed for ${resourceUrl}`,
        error,
      );
      return null;
    }
  }

  public static extractMatchId(input: string): string | null {
    const trimmed = (input ?? "").trim();
    const fromRoom = trimmed.match(/room\/(1-[0-9a-fA-F-]+)/);
    if (fromRoom) {
      return fromRoom[1];
    }
    if (/^1-[0-9a-fA-F-]+$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  public async resolvePlayerId(steamId: string): Promise<string | null> {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: { steam_id: steamId },
        faceit_player_id: true,
      },
    });
    if (players_by_pk?.faceit_player_id) {
      return players_by_pk.faceit_player_id;
    }

    const noAccountKey = FaceitService.noAccountKey(steamId);
    if (await this.cache.has(noAccountKey)) {
      return null;
    }

    const lookup = await this.fetchPlayer(steamId);
    if (lookup.status !== "ok") {
      if (lookup.status === "not_found") {
        await this.cache.put(
          noAccountKey,
          true,
          FaceitService.NO_ACCOUNT_TTL_SECONDS,
        );
      }
      return null;
    }
    if (!lookup.data.faceit_player_id) {
      await this.cache.put(
        noAccountKey,
        true,
        FaceitService.NO_ACCOUNT_TTL_SECONDS,
      );
      return null;
    }
    return lookup.data.faceit_player_id;
  }

  public async getRecentMatches(
    playerId: string,
    options: { sinceSeconds?: number; limit?: number } = {},
  ): Promise<Array<{ matchId: string; finishedAt: number | null }>> {
    const limit = options.limit ?? 20;
    const from = options.sinceSeconds ? `&from=${options.sinceSeconds}` : "";
    const data = await this.get<{
      items?: Array<{ match_id: string; finished_at?: number }>;
    }>(
      `/players/${encodeURIComponent(playerId)}/history?game=cs2&offset=0&limit=${limit}${from}`,
    );
    return (data?.items ?? [])
      .filter((item) => item.match_id)
      .map((item) => ({
        matchId: item.match_id,
        finishedAt: item.finished_at ?? null,
      }));
  }

  public async getLatestCompletedMatchAt(
    playerId: string,
  ): Promise<{ ok: boolean; finishedAt: string | null }> {
    const path = `/players/${encodeURIComponent(playerId)}/history?game=cs2&offset=0&limit=20`;
    const url = `${FaceitService.BASE_URL}${path}`;
    this.logger.debug(`faceit GET ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for latest match of ${playerId}`,
        );
        return { ok: false, finishedAt: null };
      }

      const data = (await response.json()) as { items?: FaceitHistoryItem[] };
      return {
        ok: true,
        finishedAt: latestCompletedFaceitMatchAt(data.items ?? []),
      };
    } catch (error) {
      this.logger.error(
        `faceit latest-match request failed for ${playerId}`,
        error,
      );
      return { ok: false, finishedAt: null };
    }
  }

  // Best-effort per-match elo from the match page (keyed by steam id). Returns
  // whatever the match roster exposes — FACEIT does not always include elo, so
  // callers fall back to the player's current elo when a steam id is absent.
  public async getMatchEloMap(
    matchId: string,
  ): Promise<Record<string, number>> {
    const data = await this.get<{
      teams?: Record<
        string,
        {
          roster?: Array<{ game_player_id?: string; elo?: number }>;
        }
      >;
    }>(`/matches/${encodeURIComponent(matchId)}`);
    const out: Record<string, number> = {};
    for (const team of Object.values(data?.teams ?? {})) {
      for (const member of team.roster ?? []) {
        if (
          member.game_player_id &&
          /^\d+$/.test(member.game_player_id) &&
          typeof member.elo === "number"
        ) {
          out[member.game_player_id] = member.elo;
        }
      }
    }
    return out;
  }

  public async getMatchDemo(
    matchId: string,
  ): Promise<{ demoUrl: string | null; startedAt: string | null }> {
    const data = await this.get<{
      demo_url?: string[];
      started_at?: number;
      finished_at?: number;
    }>(`/matches/${encodeURIComponent(matchId)}`);
    const demoUrl = (data?.demo_url ?? []).find((url) => !!url) ?? null;
    const ts = data?.finished_at ?? data?.started_at ?? null;
    return {
      demoUrl,
      startedAt: ts ? new Date(ts * 1000).toISOString() : null,
    };
  }

  private async get<T>(path: string): Promise<T | null> {
    const url = `${FaceitService.BASE_URL}${path}`;
    this.logger.debug(`faceit GET ${url}`);
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for ${path}`,
        );
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(`faceit request failed for ${path}`, error);
      return null;
    }
  }

  public async refreshPlayer(steamId: string, force = false): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const cacheKey = FaceitService.cacheKey(steamId);
    const noAccountKey = FaceitService.noAccountKey(steamId);
    if (!force && (await this.cache.has(noAccountKey))) {
      return false;
    }
    if (!force && (await this.cache.has(cacheKey))) {
      return false;
    }

    await this.cache.put(
      cacheKey,
      true,
      FaceitService.REFRESH_INTERVAL_SECONDS,
    );

    this.logger.debug(`faceit refresh start for ${steamId}`);
    const startedAt = Date.now();
    const lookup = await this.fetchPlayer(steamId);
    const elapsedMs = Date.now() - startedAt;

    if (lookup.status !== "ok") {
      if (lookup.status === "not_found") {
        await this.cache.put(
          noAccountKey,
          true,
          FaceitService.NO_ACCOUNT_TTL_SECONDS,
        );
      }
      // A missing profile or an unavailable API never clears cached ratings.
      this.logger.debug(
        `faceit fetched for ${steamId} in ${elapsedMs}ms: ${lookup.status}, skipping db write`,
      );
      return false;
    }

    const data = lookup.data;
    const latestMatch = await this.getLatestCompletedMatchAt(
      data.faceit_player_id,
    );

    this.logger.debug(
      `faceit fetched for ${steamId} in ${elapsedMs}ms: ` +
        `nickname=${data.faceit_nickname} ` +
        `level=${data.faceit_skill_level} ` +
        `elo=${data.faceit_elo}`,
    );

    await this.postgres.query(
      `UPDATE public.players
          SET faceit_player_id = $2,
              faceit_nickname = $3,
              faceit_skill_level = $4,
              faceit_elo = $5,
              faceit_url = $6,
              faceit_updated_at = now(),
              faceit_last_match_at = CASE
                WHEN $8::boolean THEN $7::timestamptz
                ELSE faceit_last_match_at
              END
        WHERE steam_id = $1::bigint`,
      [
        steamId,
        data.faceit_player_id,
        data.faceit_nickname,
        data.faceit_skill_level,
        data.faceit_elo,
        data.faceit_url,
        latestMatch.finishedAt,
        latestMatch.ok,
      ],
    );

    this.logger.debug(`faceit row written for ${steamId}`);

    return true;
  }

  public async refreshVerifiedPlayers(): Promise<{
    eligible: number;
    refreshed: number;
    skipped: number;
    failed: number;
  }> {
    if (!this.isEnabled()) {
      return { eligible: 0, refreshed: 0, skipped: 0, failed: 0 };
    }

    const selectedPlayers = await this.postgres.query<
      Array<{ steam_id: string }>
    >(
      `SELECT steam_id::text
         FROM public.players
        WHERE role = ANY($1::text[])
          AND (
            faceit_updated_at IS NULL
            OR faceit_updated_at < now() - ($2::text || ' hours')::interval
          )
          AND (
            faceit_refresh_attempted_at IS NULL
            OR faceit_refresh_attempted_at < now() - ($3::text || ' minutes')::interval
          )
        ORDER BY faceit_refresh_attempted_at ASC NULLS FIRST,
                 faceit_updated_at ASC NULLS FIRST,
                 steam_id ASC
        LIMIT $4`,
      [
        FaceitService.VERIFIED_ROLES,
        FaceitService.LEADERBOARD_STALE_HOURS,
        FaceitService.LEADERBOARD_FAILED_RETRY_MINUTES,
        FaceitService.LEADERBOARD_REFRESH_LIMIT,
      ],
    );
    const players = selectedPlayers.slice(
      0,
      FaceitService.LEADERBOARD_REFRESH_LIMIT,
    );

    let next = 0;
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;
    const worker = async () => {
      while (next < players.length) {
        const player = players[next++];
        try {
          // Record scheduling attempts before any cache/API work. This also
          // advances cached no-account rows, so they cannot monopolize the
          // front of every batch while valid cached ratings remain untouched.
          await this.postgres.query(
            `UPDATE public.players
                SET faceit_refresh_attempted_at = now()
              WHERE steam_id = $1::bigint`,
            [player.steam_id],
          );
          if (await this.refreshPlayer(player.steam_id)) {
            refreshed++;
          } else {
            skipped++;
          }
        } catch (error) {
          failed++;
          this.logger.warn(
            `faceit verified-player refresh failed for ${player.steam_id}: ${(error as Error)?.message ?? String(error)}`,
          );
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            FaceitService.LEADERBOARD_REFRESH_CONCURRENCY,
            players.length,
          ),
        },
        worker,
      ),
    );

    return { eligible: players.length, refreshed, skipped, failed };
  }

  private async fetchPlayer(steamId: string): Promise<FaceitPlayerLookup> {
    const url = `${FaceitService.BASE_URL}/players?game=cs2&game_player_id=${encodeURIComponent(
      steamId,
    )}`;

    this.logger.debug(`faceit GET ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status === 404) {
        this.logger.debug(
          `faceit 404 for steam_id ${steamId} — no faceit account linked`,
        );
        return { status: "not_found" };
      }

      if (!response.ok) {
        this.logger.error(
          `faceit responded with ${response.status} for steam_id ${steamId}`,
        );
        return { status: "unavailable" };
      }

      const data = (await response.json()) as {
        player_id: string;
        nickname: string;
        faceit_url?: string;
        games?: {
          cs2?: {
            skill_level?: number;
            faceit_elo?: number;
          };
        };
      };

      const cs2 = data.games?.cs2;

      return {
        status: "ok",
        data: {
          faceit_player_id: data.player_id,
          faceit_nickname: data.nickname,
          faceit_url: data.faceit_url
            ? data.faceit_url.replace("{lang}", "en")
            : null,
          faceit_skill_level: cs2?.skill_level ?? null,
          faceit_elo: cs2?.faceit_elo ?? null,
        },
      };
    } catch (error) {
      this.logger.error(
        `unable to fetch faceit profile for steam_id ${steamId}`,
        error,
      );
      return { status: "unavailable" };
    }
  }

  private static cacheKey(steamId: string): string {
    return `faceit:refresh-lock:cs2:${steamId}`;
  }

  private static noAccountKey(steamId: string): string {
    return `faceit:no-account:cs2:${steamId}`;
  }
}
