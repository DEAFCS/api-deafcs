// Single source of truth mapping every `e_notification_types` value to the
// coarse-grained category a player can toggle in Settings -> Notifications.
// There are ~30 individual types (see hasura/migrations for the full enum)
// and showing all of them as separate switches would be unusable, so push
// preferences are stored per-category, not per-type (see
// push_notification_preferences).
export const NOTIFICATION_CATEGORIES: Record<string, string[]> = {
  chat: ["ChatMessage"],
  tournaments: ["TournamentCreated", "TournamentReminder"],
  matches: ["MatchStatusChange", "MatchImported", "MatchSupport"],
  sanctions: ["PlayerSanctioned"],
  scrims: [
    "ScrimAlertMatch",
    "ScrimMatchCanceled",
    "ScrimMatchScheduled",
    "ScrimRequestAccepted",
    "ScrimRequestCountered",
    "ScrimRequestDeclined",
    "ScrimRequestExpired",
    "ScrimRequestReceived",
    "ScrimTimeChanged",
  ],
  leagues: [
    "LeagueMatchUnscheduled",
    "LeagueProposalAccepted",
    "LeagueProposalDeclined",
    "LeagueProposalReceived",
    "LeagueRegistrationDecision",
    "LeagueRosterUndersized",
  ],
  account: [
    "NameChangeApproved",
    "NameChangeDenied",
    "NameChangeRequest",
    "FormTeamSuggestion",
  ],
  // Admin/system broadcasts (role: administrator) -- only ever reach admins
  // in practice since handleNotificationInsert's role-broadcast check
  // already gates on isRoleAbove, but still exposed as its own category so
  // an admin can mute them independently of everything else.
  system: [
    "DedicatedServerRconStatus",
    "DedicatedServerStatus",
    "EloRecompute",
    "GameNodeStatus",
    "GameUpdate",
    "PlayerReindex",
    "StorageScan",
  ],
};

export const NOTIFICATION_CATEGORY_KEYS = Object.keys(NOTIFICATION_CATEGORIES);

const TYPE_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(NOTIFICATION_CATEGORIES).flatMap(([category, types]) =>
    types.map((type) => [type, category]),
  ),
);

export function categoryForType(type: string): string | null {
  return TYPE_TO_CATEGORY[type] ?? null;
}
