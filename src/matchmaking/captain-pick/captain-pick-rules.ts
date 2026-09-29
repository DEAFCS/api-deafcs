import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";

/**
 * Pure 5v5 Captain Pick rules: no Redis, Hasura, BullMQ, sockets or
 * draft_games. Callers own persistence, timing and who is allowed to act;
 * this module only decides what a valid draft looks like.
 *
 * Lineup 1 is always the captain who picks first, lineup 2 the other one.
 */

export const CAPTAIN_PICK_PLAYER_COUNT = ExpectedPlayers.Competitive;
export const CAPTAIN_PICK_TEAM_SIZE = CAPTAIN_PICK_PLAYER_COUNT / 2;

export type CaptainPickLineup = 1 | 2;

export interface CaptainPickParticipant {
  steam_id: string;
  elo: number;
  joinedAt: Date | string | number;
}

/**
 * Result of the server-side coin flip used only when both captains have
 * exactly the same ELO: the index (into the selected captains) of the one
 * who picks first. Always produced by the server, never by a client.
 */
export type CaptainPickCoinFlip = 0 | 1;

export type CaptainPickFirstPickReason = "LowerElo" | "EqualEloCoinFlip";

export class CaptainPickRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptainPickRuleError";
  }
}

function joinedAtTime(participant: CaptainPickParticipant): number {
  return new Date(participant.joinedAt).getTime();
}

// Steam IDs are 17-digit numbers, larger than Number.MAX_SAFE_INTEGER.
function compareSteamIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const difference = BigInt(a) - BigInt(b);
    return difference === 0n ? 0 : difference < 0n ? -1 : 1;
  }

  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Shared ordering for captain selection and auto-pick: higher ELO first,
 * then whoever joined the queue earlier, then a stable steam ID order.
 */
export function compareCaptainPickPriority(
  a: CaptainPickParticipant,
  b: CaptainPickParticipant,
): number {
  if (a.elo !== b.elo) {
    return b.elo - a.elo;
  }

  const joinedDifference = joinedAtTime(a) - joinedAtTime(b);
  if (joinedDifference !== 0) {
    return joinedDifference;
  }

  return compareSteamIds(a.steam_id, b.steam_id);
}

function assertValidParticipants(
  participants: ReadonlyArray<CaptainPickParticipant>,
) {
  const seen = new Set<string>();

  for (const participant of participants) {
    if (!participant.steam_id) {
      throw new CaptainPickRuleError("participant is missing a steam id");
    }
    if (seen.has(participant.steam_id)) {
      throw new CaptainPickRuleError(
        `participant ${participant.steam_id} appears more than once`,
      );
    }
    if (!Number.isFinite(participant.elo)) {
      throw new CaptainPickRuleError(
        `participant ${participant.steam_id} has an invalid elo`,
      );
    }
    if (!Number.isFinite(joinedAtTime(participant))) {
      throw new CaptainPickRuleError(
        `participant ${participant.steam_id} has an invalid queue time`,
      );
    }
    seen.add(participant.steam_id);
  }
}

function sortByPriority<T extends CaptainPickParticipant>(
  participants: ReadonlyArray<T>,
): Array<T> {
  return [...participants].sort(compareCaptainPickPriority);
}

/**
 * The two highest-ELO confirmed players captain. Returned in priority order,
 * with everyone else as the pick pool (also in priority order).
 */
export function selectCaptains<T extends CaptainPickParticipant>(
  participants: ReadonlyArray<T>,
): { captains: [T, T]; pool: Array<T> } {
  if (participants.length !== CAPTAIN_PICK_PLAYER_COUNT) {
    throw new CaptainPickRuleError(
      `Captain Pick needs exactly ${CAPTAIN_PICK_PLAYER_COUNT} players, got ${participants.length}`,
    );
  }

  assertValidParticipants(participants);

  const [first, second, ...pool] = sortByPriority(participants);

  return { captains: [first, second], pool };
}

/**
 * The lower-rated captain picks first. With exactly equal ELO there is no
 * lower one, so the server's coin flip decides and must be supplied.
 */
export function determineFirstPick<T extends CaptainPickParticipant>(
  captains: readonly [T, T],
  equalEloCoinFlip?: CaptainPickCoinFlip,
): {
  firstPicker: T;
  secondPicker: T;
  reason: CaptainPickFirstPickReason;
} {
  const [a, b] = captains;

  if (a.elo !== b.elo) {
    const [lower, higher] = a.elo < b.elo ? [a, b] : [b, a];
    return { firstPicker: lower, secondPicker: higher, reason: "LowerElo" };
  }

  if (equalEloCoinFlip !== 0 && equalEloCoinFlip !== 1) {
    throw new CaptainPickRuleError(
      "captains have equal elo, a server coin flip is required",
    );
  }

  return {
    firstPicker: captains[equalEloCoinFlip],
    secondPicker: captains[equalEloCoinFlip === 0 ? 1 : 0],
    reason: "EqualEloCoinFlip",
  };
}

/**
 * Snake order over every non-captain slot, mirroring the Draft Games Snake
 * pattern (get_draft_game_pattern.sql): 1,2,2,1,1,2,2,1 for 10 players.
 * Includes the final slot, which is never actually picked.
 */
export function buildCaptainPickPattern(
  playerCount: number = CAPTAIN_PICK_PLAYER_COUNT,
): Array<CaptainPickLineup> {
  if (!Number.isInteger(playerCount) || playerCount < 4 || playerCount % 2) {
    throw new CaptainPickRuleError(`unsupported player count ${playerCount}`);
  }

  const picks = playerCount - 2;
  const perTeamPicks = playerCount / 2 - 1;
  const pattern: Array<CaptainPickLineup> = [];
  const counts = { 1: 0, 2: 0 };

  for (let i = 0; i < picks; i++) {
    const forward = Math.floor(i / 2) % 2 === 0;
    let lineup: CaptainPickLineup = forward === (i % 2 === 0) ? 1 : 2;

    if (counts[lineup] >= perTeamPicks) {
      lineup = lineup === 1 ? 2 : 1;
    }

    counts[lineup]++;
    pattern.push(lineup);
  }

  return pattern;
}

/**
 * The timed selections a captain (or auto-pick) actually makes. The last
 * pattern slot is dropped: by then one player is left and only one lineup
 * has room, so it is assigned without a click.
 */
export function getManualPickOrder(
  playerCount: number = CAPTAIN_PICK_PLAYER_COUNT,
): Array<CaptainPickLineup> {
  return buildCaptainPickPattern(playerCount).slice(0, -1);
}

export function getPickingLineup(
  pickIndex: number,
  playerCount: number = CAPTAIN_PICK_PLAYER_COUNT,
): CaptainPickLineup | null {
  return getManualPickOrder(playerCount)[pickIndex] ?? null;
}

/** On timeout: highest ELO, then earliest queue time, then steam ID. */
export function selectAutoPick<T extends CaptainPickParticipant>(
  available: ReadonlyArray<T>,
): T {
  if (available.length === 0) {
    throw new CaptainPickRuleError("no players left to auto-pick");
  }

  assertValidParticipants(available);

  return sortByPriority(available)[0];
}

export type CaptainPickLineups = Record<CaptainPickLineup, Array<string>>;

/** The lineup the single remaining player must join. */
export function resolveLastPlayerLineup(
  lineups: CaptainPickLineups,
  remainingCount: number,
  teamSize: number = CAPTAIN_PICK_TEAM_SIZE,
): CaptainPickLineup {
  if (remainingCount !== 1) {
    throw new CaptainPickRuleError(
      `last-player assignment needs exactly 1 remaining player, got ${remainingCount}`,
    );
  }

  const open = ([1, 2] as const).filter(
    (lineup) => lineups[lineup].length < teamSize,
  );

  if (open.length !== 1 || lineups[open[0]].length !== teamSize - 1) {
    throw new CaptainPickRuleError(
      `lineups ${lineups[1].length}/${lineups[2].length} cannot take one last player`,
    );
  }

  return open[0];
}

export interface CaptainPickSelection {
  pickIndex: number;
  lineup: CaptainPickLineup;
  steam_id: string;
  auto: boolean;
}

export interface CaptainPickDraft<
  T extends CaptainPickParticipant = CaptainPickParticipant,
> {
  captains: Record<CaptainPickLineup, T>;
  firstPickReason: CaptainPickFirstPickReason;
  lineups: CaptainPickLineups;
  available: Array<T>;
  selections: Array<CaptainPickSelection>;
  // Index of the next manual pick, or null once the teams are complete.
  pickIndex: number | null;
}

export function createCaptainPickDraft<T extends CaptainPickParticipant>(
  participants: ReadonlyArray<T>,
  equalEloCoinFlip?: CaptainPickCoinFlip,
): CaptainPickDraft<T> {
  const { captains, pool } = selectCaptains(participants);
  const { firstPicker, secondPicker, reason } = determineFirstPick(
    captains,
    equalEloCoinFlip,
  );

  return {
    captains: { 1: firstPicker, 2: secondPicker },
    firstPickReason: reason,
    lineups: { 1: [firstPicker.steam_id], 2: [secondPicker.steam_id] },
    available: pool,
    selections: [],
    pickIndex: 0,
  };
}

/**
 * Applies the current pick and, after the seventh, auto-assigns the last
 * player. Returns a new draft; the input is never mutated. Whether the
 * caller is allowed to make this pick (right captain, before the deadline)
 * is the caller's job.
 */
export function applyCaptainPick<T extends CaptainPickParticipant>(
  draft: CaptainPickDraft<T>,
  pickedSteamId: string,
  options: { auto?: boolean } = {},
): CaptainPickDraft<T> {
  if (draft.pickIndex === null) {
    throw new CaptainPickRuleError("the teams are already complete");
  }

  const lineup = getPickingLineup(draft.pickIndex);
  if (lineup === null) {
    throw new CaptainPickRuleError(`no pick at index ${draft.pickIndex}`);
  }

  const picked = draft.available.find(
    (participant) => participant.steam_id === pickedSteamId,
  );
  if (!picked) {
    throw new CaptainPickRuleError(`${pickedSteamId} is not available to pick`);
  }

  const lineups: CaptainPickLineups = {
    1: [...draft.lineups[1]],
    2: [...draft.lineups[2]],
  };
  lineups[lineup].push(picked.steam_id);

  const available = draft.available.filter(
    (participant) => participant.steam_id !== pickedSteamId,
  );
  const selections = [
    ...draft.selections,
    {
      pickIndex: draft.pickIndex,
      lineup,
      steam_id: picked.steam_id,
      auto: options.auto === true,
    },
  ];

  const nextPickIndex = draft.pickIndex + 1;

  if (nextPickIndex < getManualPickOrder().length) {
    return {
      ...draft,
      lineups,
      available,
      selections,
      pickIndex: nextPickIndex,
    };
  }

  const [last] = available;
  lineups[resolveLastPlayerLineup(lineups, available.length)].push(
    last.steam_id,
  );

  return {
    ...draft,
    lineups,
    available: [],
    selections,
    pickIndex: null,
  };
}

/** What a timeout does: pick the best remaining player for the captain. */
export function applyCaptainAutoPick<T extends CaptainPickParticipant>(
  draft: CaptainPickDraft<T>,
): CaptainPickDraft<T> {
  return applyCaptainPick(draft, selectAutoPick(draft.available).steam_id, {
    auto: true,
  });
}
