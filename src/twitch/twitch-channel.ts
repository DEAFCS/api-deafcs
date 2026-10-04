// Normalizes what a player types into the Twitch field of Profile Settings
// to the channel login stored in players.twitch_channel.
//
// Accepted:  "TricoN", "@tricon", "twitch.tv/tricon",
//            "https://www.twitch.tv/TricoN/", "m.twitch.tv/tricon?x=1"
// Rejected:  clip / video / other Twitch pages, other sites, anything that
//            is not a valid Twitch login (4-25 letters, digits, underscore).
// Empty input clears the field.

export const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{4,25}$/;

const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);

// First path segments on twitch.tv that are pages, not channels.
const RESERVED_PATHS = new Set([
  "videos",
  "video",
  "clip",
  "clips",
  "directory",
  "downloads",
  "drops",
  "inventory",
  "jobs",
  "login",
  "messages",
  "p",
  "payments",
  "popout",
  "prime",
  "search",
  "settings",
  "signup",
  "store",
  "subscriptions",
  "turbo",
  "wallet",
  "embed",
  "moderator",
  "team",
]);

export type TwitchChannelResult =
  | { ok: true; channel: string | null }
  | { ok: false; error: "invalid_url" | "unsupported_url" | "invalid_channel" };

export function normalizeTwitchChannel(
  input: string | null | undefined,
): TwitchChannelResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, channel: null };

  let candidate = raw;
  const looksLikeUrl = /[/.:]/.test(raw);

  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: false, error: "invalid_url" };
    }
    if (!TWITCH_HOSTS.has(url.hostname.toLowerCase())) {
      return { ok: false, error: "unsupported_url" };
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return { ok: false, error: "unsupported_url" };
    candidate = segments[0];
    if (RESERVED_PATHS.has(candidate.toLowerCase())) {
      return { ok: false, error: "unsupported_url" };
    }
  } else if (candidate.startsWith("@")) {
    candidate = candidate.slice(1);
  }

  const login = candidate.toLowerCase();
  if (!TWITCH_LOGIN_PATTERN.test(login)) {
    return { ok: false, error: "invalid_channel" };
  }
  return { ok: true, channel: login };
}

export function twitchChannelUrl(channel: string): string {
  return `https://www.twitch.tv/${channel}`;
}
