import { createHash } from "crypto";

// Clip view counting for clips the API streams itself (the MinIO fallback in
// ClipDownloadController). The Cloudflare Worker counts the same way for
// installs that front clips with it (cloudflare-workers/backblaze-proxy), so
// the rules match: one view once playback reaches the middle of the file,
// not for downloads, previews or bots, deduped per viewer by the service.

export const CLIP_VIEW_FRACTION = 0.5;

export const CLIP_VIEW_BOT_UA =
  /bot|crawl|spider|facebookexternalhit|slack|discord|telegram|whatsapp|preview|unfurl|embed|scrape|metainspector|skype|vkshare|redditbot|pinterest|googlebot|bingbot/i;

// Whether a request is a playback we may count at all. The byte threshold is
// applied separately, as the response is streamed (see createClipViewMeter).
export function shouldTrackClipView(request: {
  method: string;
  dl?: string;
  download?: string;
  noview?: string;
  userAgent?: string;
}): boolean {
  if (request.method !== "GET") {
    return false;
  }
  if (
    request.dl === "1" ||
    request.download === "1" ||
    request.noview === "1"
  ) {
    return false;
  }
  return !CLIP_VIEW_BOT_UA.test(request.userAgent ?? "");
}

// Stable per-viewer key, the same shape the Worker sends: a SHA-256 of
// ip + user agent, truncated to 32 hex characters. Only the hash leaves this
// function, so no address is stored in Redis.
export function clipViewerKey(
  ip: string | undefined,
  userAgent: string | undefined,
): string {
  return createHash("sha256")
    .update(`${ip ?? ""}\n${userAgent ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

// Fires once when a response that starts at `rangeStart` has delivered the
// byte at the file's midpoint. Counting delivered bytes, not the requested
// range, keeps a metadata probe or an aborted preload from counting, and a
// request that starts past the midpoint (tail seek, end-of-file moov probe)
// can never qualify.
export function createClipViewMeter(
  rangeStart: number,
  totalSize: number,
  onQualified: () => void,
): { add: (bytes: number) => void } {
  const threshold = totalSize * CLIP_VIEW_FRACTION;
  if (!(totalSize > 0) || rangeStart > threshold) {
    return { add: () => {} };
  }

  let position = rangeStart;
  let fired = false;
  return {
    add(bytes: number) {
      if (fired) {
        return;
      }
      position += bytes;
      if (position >= threshold) {
        fired = true;
        onQualified();
      }
    },
  };
}
