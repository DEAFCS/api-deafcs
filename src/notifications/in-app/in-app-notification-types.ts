// Single source of truth for which individual `e_notification_types`
// values a player can toggle for the in-app alert bell specifically.
// Deliberately separate from notification-categories.ts (the push side):
// push preferences group ~30 types into ~9 coarse categories because
// showing every type as its own switch there would be unusable, but the
// in-app bell only ever exposes a small, hand-picked set of individual
// types -- everything else always fires exactly as it does today, with
// no user control surface at all.
export type InAppNotificationTypeConfig = {
  type: string;
  defaultEnabled: boolean;
  adminOnly: boolean;
};

export const IN_APP_TOGGLEABLE_TYPES: InAppNotificationTypeConfig[] = [
  { type: "ChatMessage", defaultEnabled: true, adminOnly: false },
  { type: "GlobalChatMessage", defaultEnabled: true, adminOnly: false },
  { type: "MatchImported", defaultEnabled: false, adminOnly: false },
  { type: "NewsPublished", defaultEnabled: true, adminOnly: false },
  { type: "DedicatedServerRconStatus", defaultEnabled: true, adminOnly: true },
  { type: "DedicatedServerStatus", defaultEnabled: true, adminOnly: true },
  { type: "EloRecompute", defaultEnabled: true, adminOnly: true },
  { type: "GameNodeStatus", defaultEnabled: true, adminOnly: true },
  { type: "GameUpdate", defaultEnabled: true, adminOnly: true },
  { type: "PlayerReindex", defaultEnabled: true, adminOnly: true },
];

const CONFIG_BY_TYPE = new Map(
  IN_APP_TOGGLEABLE_TYPES.map((c) => [c.type, c]),
);

export function isInAppTypeToggleable(type: string): boolean {
  return CONFIG_BY_TYPE.has(type);
}

// Only meaningful for toggleable types -- everything else always fires
// (there's no preference row to even check for them).
export function inAppDefaultEnabled(type: string): boolean {
  return CONFIG_BY_TYPE.get(type)?.defaultEnabled ?? true;
}
