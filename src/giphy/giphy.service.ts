import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";

export type GiphyResult = {
  id: string;
  previewUrl: string;
  sendUrl: string;
  width: number;
  height: number;
};

type GiphyApiImage = { url: string; width: string; height: string };
type GiphyApiGif = {
  id: string;
  images: {
    original: GiphyApiImage;
    fixed_width_small?: GiphyApiImage;
    fixed_width?: GiphyApiImage;
  };
};

// Search results only, not persisted -- GIPHY's API terms don't allow
// caching their content past what's needed to serve it, so this only
// caches the search response itself for a few minutes to stay well
// under the free Beta key's 100 requests/hour limit for repeated or
// popular searches, never the GIF bytes themselves (still served
// straight from GIPHY's own CDN on every render).
@Injectable()
export class GiphyService {
  private static readonly BASE_URL = "https://api.giphy.com/v1/gifs";
  private static readonly CACHE_TTL_SECONDS = 5 * 60;
  private static readonly RESULT_LIMIT = 24;
  private readonly apiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly logger: Logger,
  ) {
    this.apiKey = this.config.get("giphy.apiKey");
  }

  public isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  public async search(query: string): Promise<GiphyResult[]> {
    const trimmed = query.trim();
    return this.fetchAndCache(
      trimmed ? `giphy:search:${trimmed.toLowerCase()}` : "giphy:trending",
      trimmed
        ? `${GiphyService.BASE_URL}/search?api_key=${this.apiKey}&q=${encodeURIComponent(trimmed)}&limit=${GiphyService.RESULT_LIMIT}&rating=pg-13`
        : `${GiphyService.BASE_URL}/trending?api_key=${this.apiKey}&limit=${GiphyService.RESULT_LIMIT}&rating=pg-13`,
    );
  }

  private async fetchAndCache(
    cacheKey: string,
    url: string,
  ): Promise<GiphyResult[]> {
    if (!this.isEnabled()) return [];

    return (
      (await this.cache.remember(
        cacheKey,
        async () => {
          try {
            const response = await fetch(url, {
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
              this.logger.warn(`[giphy] request failed: ${response.status}`);
              return [];
            }
            const body = (await response.json()) as { data: GiphyApiGif[] };
            return body.data.map((gif) => this.toResult(gif));
          } catch (error) {
            this.logger.warn("[giphy] request errored", error as Error);
            return [];
          }
        },
        GiphyService.CACHE_TTL_SECONDS,
      )) ?? []
    );
  }

  private toResult(gif: GiphyApiGif): GiphyResult {
    const preview =
      gif.images.fixed_width_small ??
      gif.images.fixed_width ??
      gif.images.original;
    return {
      id: gif.id,
      previewUrl: preview.url,
      sendUrl: gif.images.original.url,
      width: Number(gif.images.original.width),
      height: Number(gif.images.original.height),
    };
  }
}
