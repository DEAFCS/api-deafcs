import {
  e_map_pool_types_enum,
  e_match_types_enum,
  e_timeout_settings_enum,
} from "generated";

/**
 * The match options every matchmaking match is created with. Shared so a
 * Captain Pick match is exactly as ordinary as a Standard one: same pool
 * (and therefore the normal map veto), MR, knife, overtime and timeouts.
 */
export function getMatchmakingMatchSetup(
  type: e_match_types_enum,
  region: string,
): {
  mapPoolType: e_map_pool_types_enum;
  options: {
    mr: number;
    best_of: number;
    knife: boolean;
    overtime: boolean;
    timeout_setting: e_timeout_settings_enum;
    region: string;
  };
} {
  return {
    // e_map_pool_types_enum doesn't include Premier/Faceit (imports only).
    mapPoolType: type === "Premier" || type === "Faceit" ? "Competitive" : type,
    options: {
      mr: type === "Competitive" ? 12 : 8,
      best_of: 1,
      knife: true,
      overtime: true,
      // Any player on the team may call .tac/.timeout, not just the
      // captain or coach.
      timeout_setting: "CoachAndPlayers",
      region,
    },
  };
}
