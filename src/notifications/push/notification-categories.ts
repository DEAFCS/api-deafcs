// Single source of truth mapping every `e_notification_types` value to the
// coarse-grained category a player can toggle in Settings -> Notifications.
// There are ~30 individual types (see hasura/migrations for the full enum)
// and showing all of them as separate switches would be unusable, so push
// preferences are stored per-category, not per-type (see
// push_notification_preferences).
export const NOTIFICATION_CATEGORIES: Record<string, string[]> = {
  // Non-match lobby chats (matchmaking queue, draft, tournament, …).
  // Match chat is deliberately its own category below -- it fires far
  // more often once a match is actually live, and got reported as
  // distracting during active play (buzzing the phone mid-match).
  chat: ["ChatMessage"],
  match_chat: ["MatchChatMessage"],
  // Separate from `chat` on purpose -- Global Chat is high-traffic, so it
  // defaults to OFF (see CATEGORY_DEFAULT_ENABLED below) unlike every
  // other category, which defaults to on.
  global_chat: ["GlobalChatMessage"],
  // Was bundled under `chat` (shared with matchmaking/draft/tournament
  // chat) with no way to mute/enable it independently -- split out on
  // request. Role-gated (match_organizer+), not a fixed roster, so it's
  // also its own early-return branch in ChatService.notifyLobbyMembers.
  organizer_chat: ["OrganizerChatMessage"],
  news: ["NewsPublished"],
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

// Every category defaults to enabled (absence of a preference row means
// "on") except the ones listed here explicitly as opt-in.
const OPT_IN_CATEGORIES = new Set(["global_chat", "match_chat"]);

export function isCategoryEnabledByDefault(category: string): boolean {
  return !OPT_IN_CATEGORIES.has(category);
}

const TYPE_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(NOTIFICATION_CATEGORIES).flatMap(([category, types]) =>
    types.map((type) => [type, category]),
  ),
);

export function categoryForType(type: string): string | null {
  return TYPE_TO_CATEGORY[type] ?? null;
}
