import Redis from "ioredis";
import {
  getCaptainPickDraftCacheKey,
  getMatchConfirmationKey,
} from "../utilities/cacheKeys";

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

/**
 * The ten players of a Captain Pick draft use the real match's Match chat
 * from the start, but are only seated in its lineups once the teams lock.
 * Until then (match still PickingPlayers) this lets exactly them in: the
 * match must map to a draft (matches:confirmation, written by the server when
 * the shell is created), that draft must be this match's, not Failed, and
 * list the player among its committed participants.
 */
export async function isCaptainPickPlayerOfMatch(
  redis: Redis,
  matchId: string,
  matchStatus: string | null | undefined,
  steamId: string,
): Promise<boolean> {
  if (matchStatus !== "PickingPlayers" || !matchId) {
    return false;
  }

  const draftId = await redis.get(getMatchConfirmationKey(matchId));
  if (!draftId) {
    return false;
  }

  const raw = await redis.hget(getCaptainPickDraftCacheKey(draftId), "state");
  if (!raw) {
    return false;
  }

  let state: {
    phase?: string;
    matchId?: string | null;
    participants?: Array<{ steam_id?: unknown }>;
  };
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }

  return (
    state?.phase !== "Failed" &&
    state?.matchId === matchId &&
    Array.isArray(state.participants) &&
    state.participants.some(
      (participant) => String(participant?.steam_id) === String(steamId),
    )
  );
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

  const raw = await redis.hget(
    getCaptainPickDraftCacheKey(room.draftId),
    "state",
  );
  if (!raw) {
    return false;
  }

  let state: Parameters<typeof captainPickTeamOf>[0];
  try {
    state = JSON.parse(raw);
  } catch {
    return false;
  }

  return captainPickTeamOf(state, steamId) === room.lineup;
}
