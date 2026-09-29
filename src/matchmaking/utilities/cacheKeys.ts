import { e_match_types_enum } from "generated";
import {
  DEFAULT_MATCHMAKING_QUEUE_VARIANT,
  isQueueVariantAllowedForType,
  MatchmakingQueueVariant,
  resolveMatchmakingQueueVariant,
} from "../types/MatchmakingQueueVariant";

const version = "v20";

// Standard queues keep their original (suffix-free) keys so lobbies already
// queued in Redis stay valid across deploys. An unknown variant throws rather
// than quietly landing in a Standard queue.
function getQueueVariantSuffix(
  type: e_match_types_enum,
  variant: MatchmakingQueueVariant,
) {
  const resolved = resolveMatchmakingQueueVariant(variant);

  if (!resolved || !isQueueVariantAllowedForType(type, resolved)) {
    throw new Error(`${variant} is not a valid ${type} matchmaking queue`);
  }

  return resolved === "CaptainPick" ? ":captain-pick" : "";
}

export function getMatchmakingQueueCacheKey(
  type: e_match_types_enum,
  region: string,
  variant: MatchmakingQueueVariant = DEFAULT_MATCHMAKING_QUEUE_VARIANT,
) {
  return `matchmaking:${version}:${region}:${type}${getQueueVariantSuffix(type, variant)}`;
}

export function getMatchmakingLobbyDetailsCacheKey(lobbyId: string) {
  return `matchmaking:${version}:details:${lobbyId}`;
}

export function getMatchmakingConformationCacheKey(confirmationId: string) {
  return `matchmaking:${version}:${confirmationId}`;
}

export function getMatchmakingRankCacheKey(
  type: e_match_types_enum,
  region: string,
  variant: MatchmakingQueueVariant = DEFAULT_MATCHMAKING_QUEUE_VARIANT,
) {
  return `matchmaking:${version}:${region}:${type}${getQueueVariantSuffix(type, variant)}:ranks`;
}

// Committed Captain Pick draft state, keyed by its ready-check confirmation.
export function getCaptainPickDraftCacheKey(confirmationId: string) {
  return `matchmaking:${version}:captain-pick:draft:${confirmationId}`;
}

// Reverse lookup: which committed draft a player belongs to. Lives apart from
// lobby details, which offline/party cleanup is free to remove.
export function getCaptainPickPlayerCacheKey(steamId: string) {
  return `matchmaking:${version}:captain-pick:player:${steamId}`;
}

// Captain Pick gets its own region lock so a Captain Pick pass can never make
// a Standard pass bail out with "another matchmaking process is running".
export function getMatchmakingRegionLockKey(
  region: string,
  variant: MatchmakingQueueVariant = DEFAULT_MATCHMAKING_QUEUE_VARIANT,
) {
  return variant === "CaptainPick"
    ? `matchmaking:lock:${region}:captain-pick`
    : `matchmaking:lock:${region}`;
}
