import { e_match_types_enum } from "generated";

/**
 * Which matchmaking queue a lobby sits in. This is NOT a match type: a
 * CaptainPick queue still produces an ordinary Competitive match, only the
 * way its teams (and map) are formed differs. Standard is every queue that
 * existed before variants did, so anything without a variant is Standard.
 */
export const MatchmakingQueueVariants = ["Standard", "CaptainPick"] as const;

export type MatchmakingQueueVariant = (typeof MatchmakingQueueVariants)[number];

export const DEFAULT_MATCHMAKING_QUEUE_VARIANT: MatchmakingQueueVariant =
  "Standard";

/**
 * Missing (legacy lobby details, older web clients) resolves to Standard.
 * Anything that is present but not a known variant resolves to undefined so
 * callers can reject it instead of silently treating it as Standard.
 */
export function resolveMatchmakingQueueVariant(
  value: unknown,
): MatchmakingQueueVariant | undefined {
  if (value === undefined || value === null) {
    return DEFAULT_MATCHMAKING_QUEUE_VARIANT;
  }

  return MatchmakingQueueVariants.find((variant) => variant === value);
}

export function isQueueVariantAllowedForType(
  type: e_match_types_enum,
  variant: MatchmakingQueueVariant,
): boolean {
  if (variant === "CaptainPick") {
    return type === "Competitive";
  }

  return true;
}

/**
 * Key used for a queue's entry in the matchmaking:region-stats payload.
 * Standard keeps the bare match type so the existing payload is unchanged;
 * CaptainPick gets its own key so its count never mixes with Standard 5v5.
 */
export function getMatchmakingRegionStatsKey(
  type: e_match_types_enum,
  variant: MatchmakingQueueVariant = DEFAULT_MATCHMAKING_QUEUE_VARIANT,
): string {
  if (variant === "CaptainPick") {
    return `${type}CaptainPick`;
  }

  return type;
}
