import Redis from "ioredis";
import { getCaptainPickDraftCacheKey } from "../utilities/cacheKeys";

/**
 * Private team chat for a matchmaking Captain Pick draft.
 *
 * The room id names a draft and a side (`${draftId}:${lineup}`), but naming
 * a room grants nothing: a player may only join or post while the committed
 * draft state in Redis has them on that exact side. So a captain has their
 * team's chat from the start, a picked player gets it the moment the server
 * commits the pick, the last auto-assigned player the moment the teams lock,
 * and nobody (unpicked, the other side, an outsider) can ever reach it by
 * changing what their client sends.
 *
 * Read straight from Redis rather than through CaptainPickService so the
 * chat module doesn't depend on the matchmaking module.
 */

// Messages live no longer than the draft itself (CAPTAIN_PICK_STATE_TTL_SECONDS).
export const CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS = 2 * 60 * 60;

export type CaptainPickTeamLineup = 1 | 2;

export function getCaptainPickTeamChatId(
  draftId: string,
  lineup: CaptainPickTeamLineup,
): string {
  return `${draftId}:${lineup}`;
}

export function parseCaptainPickTeamChatId(
  id: string,
): { draftId: string; lineup: CaptainPickTeamLineup } | null {
  const parts = String(id ?? "").split(":");
  if (parts.length !== 2 || !parts[0]) {
    return null;
  }

  const [draftId, rawLineup] = parts;
  if (rawLineup !== "1" && rawLineup !== "2") {
    return null;
  }

  return { draftId, lineup: Number(rawLineup) as CaptainPickTeamLineup };
}

/** The side a player is on in a draft's committed state, if any. */
export function captainPickTeamOf(
  state: { phase?: string; draft?: { lineups?: Record<string, unknown> } },
  steamId: string,
): CaptainPickTeamLineup | null {
  if (!state || state.phase === "Failed") {
    return null;
  }

  for (const lineup of [1, 2] as const) {
    const members = state.draft?.lineups?.[lineup];
    if (
      Array.isArray(members) &&
      members.some((member) => String(member) === String(steamId))
    ) {
      return lineup;
    }
  }

  return null;
}

type CommittedCaptainPickState = Parameters<typeof captainPickTeamOf>[0] & {
  participants?: Array<{ steam_id?: unknown }>;
};

async function readCommittedState(
  redis: Redis,
  draftId: string,
): Promise<CommittedCaptainPickState | null> {
  const raw = await redis.hget(getCaptainPickDraftCacheKey(draftId), "state");
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function canAccessCaptainPickTeamChat(
  redis: Redis,
  id: string,
  steamId: string,
): Promise<boolean> {
  const room = parseCaptainPickTeamChatId(id);
  if (!room) {
    return false;
  }

  const state = await readCommittedState(redis, room.draftId);
  if (!state) {
    return false;
  }

  return captainPickTeamOf(state, steamId) === room.lineup;
}

/**
 * Shared "Match Chat" of a Captain Pick draft (ChatLobbyType.CaptainPickMatch,
 * id = draftId): open to exactly the ten players committed to that draft,
 * whether or not they have been picked yet. Nobody else, including
 * administrators and organizers, since the match does not exist yet.
 */
export const CAPTAIN_PICK_MATCH_CHAT_TTL_SECONDS =
  CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS;

export function isCaptainPickMatchChatId(id: string): boolean {
  const draftId = String(id ?? "");
  return draftId.length > 0 && !draftId.includes(":");
}

export async function canAccessCaptainPickMatchChat(
  redis: Redis,
  id: string,
  steamId: string,
): Promise<boolean> {
  if (!isCaptainPickMatchChatId(id)) {
    return false;
  }

  const state = await readCommittedState(redis, id);
  if (!state || state.phase === "Failed") {
    return false;
  }

  return (
    Array.isArray(state.participants) &&
    state.participants.some(
      (participant) => String(participant?.steam_id) === String(steamId),
    )
  );
}
