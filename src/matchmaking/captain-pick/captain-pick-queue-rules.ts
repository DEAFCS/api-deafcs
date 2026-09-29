import { e_match_types_enum } from "generated";

export const CAPTAIN_PICK_NOT_COMPETITIVE_ERROR =
  "Captain Pick is only available for 5v5.";
export const CAPTAIN_PICK_DISABLED_ERROR =
  "5v5 Captain Pick is currently unavailable.";
export const CAPTAIN_PICK_COMMITTED_ERROR =
  "You are in a 5v5 Captain Pick match and can't leave or join another queue until it's over.";
export const CAPTAIN_PICK_SOLO_ONLY_ERROR =
  "5v5 Captain Pick is solo queue only. Leave your party to join.";

/**
 * Server-side gate for joining the Captain Pick queue. Every draft needs ten
 * individually pickable players, so V1 is solo only. Normal Competitive party
 * rules are separate and unaffected (see getPartySizeError).
 */
export function getCaptainPickJoinError(input: {
  type: e_match_types_enum;
  enabled: boolean;
  partySize: number;
}): string | undefined {
  if (input.type !== "Competitive") {
    return CAPTAIN_PICK_NOT_COMPETITIVE_ERROR;
  }

  if (!input.enabled) {
    return CAPTAIN_PICK_DISABLED_ERROR;
  }

  if (input.partySize !== 1) {
    return CAPTAIN_PICK_SOLO_ONLY_ERROR;
  }

  return undefined;
}
