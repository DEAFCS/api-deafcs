import Redis from "ioredis";
import { Queue } from "bullmq";
import { randomInt } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { HasuraService } from "src/hasura/hasura.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import {
  getCaptainPickDraftCacheKey,
  getCaptainPickPlayerCacheKey,
  getMatchConfirmationKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
} from "../utilities/cacheKeys";
import { getMatchmakingMatchSetup } from "../utilities/matchmakingMatchSetup";
import { CaptainPickSettingsService } from "./captain-pick-settings.service";
import { startCaptainPickTimer } from "./captain-pick-settings";
import {
  applyCaptainPick,
  CAPTAIN_PICK_PLAYER_COUNT,
  CAPTAIN_PICK_TEAM_SIZE,
  CaptainPickCoinFlip,
  CaptainPickDraft,
  CaptainPickLineup,
  CaptainPickParticipant,
  CaptainPickRuleError,
  createCaptainPickDraft,
  getManualPickOrder,
  getPickingLineup,
  selectAutoPick,
  selectCaptains,
} from "./captain-pick-rules";

/**
 * Committed 5v5 Captain Pick drafts.
 *
 * A draft starts once all ten players have accepted the ready check and from
 * then on is never canceled by website activity: offline captains are
 * auto-picked, the teams are always completed and an ordinary Competitive
 * match is always created. Whether someone actually shows up is decided by
 * the existing match no-show/leaver handling, same as Standard 5v5.
 *
 * The match itself (fixed id, generated at 10/10) is created as an empty
 * PickingPlayers shell right when the draft starts, so it is watchable and
 * reachable by admins while players are being picked (see
 * ensureMatchShell). Creating it is best-effort and retried; no pick ever
 * waits on Postgres. The teams are seated and veto starts only in
 * finalize(), once the draft is complete.
 *
 * State lives in one Redis hash (JSON state + version). Every change is a
 * compare-and-swap on the version, computed with the pure rules in
 * captain-pick-rules.ts, so a manual pick and a timeout (or two tabs, or two
 * workers) racing for the same pick can only ever produce one selection.
 */

export type CaptainPickPhase =
  | "Drafting"
  | "CreatingMatch"
  | "MatchCreated"
  | "Failed";

export interface CaptainPickDraftParticipant extends CaptainPickParticipant {
  lobbyId: string;
  name: string;
  avatar_url: string | null;
  joinedAt: string;
}

export interface CaptainPickState {
  confirmationId: string;
  region: string;
  phase: CaptainPickPhase;
  participants: Array<CaptainPickDraftParticipant>;
  draft: CaptainPickDraft<CaptainPickDraftParticipant>;
  // Only set when both captains had exactly equal ELO.
  coinFlip: CaptainPickCoinFlip | null;
  timer: { startedAt: string; timerSeconds: number; deadline: string } | null;
  // When each selection was made, indexed by pick index.
  pickedAt: Array<string>;
  // Generated when the teams lock so match creation can be retried safely.
  matchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CaptainPickActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptainPickActionError";
  }
}

interface InspectedMatch {
  id: string;
  status: string;
  lineupIds: Record<CaptainPickLineup, string>;
}

export type MatchInspection =
  | { kind: "missing" }
  | { kind: "complete"; match: InspectedMatch }
  | {
      kind: "partial";
      match: InspectedMatch;
      lineupsComplete: boolean;
      reason: string;
    }
  | { kind: "canceled"; match: InspectedMatch; reason: string }
  | { kind: "foreign"; match: InspectedMatch; reason: string };

export class CaptainPickFinalizeBusyError extends Error {
  constructor(confirmationId: string) {
    super(`captain pick ${confirmationId} match creation is already running`);
    this.name = "CaptainPickFinalizeBusyError";
  }
}

// Long enough to cover the ready check, 7 picks at the 120s maximum, match
// creation retries and the veto; refreshed on every transition. The match
// ending cleans it up earlier.
export const CAPTAIN_PICK_STATE_TTL_SECONDS = 2 * 60 * 60;

// A click that left the browser just before the deadline still counts.
export const CAPTAIN_PICK_MANUAL_GRACE_MS = 500;

// A timeout job is only allowed to act at (or just before) the deadline.
const CAPTAIN_PICK_TIMEOUT_EARLY_TOLERANCE_MS = 250;

// If a pick is this far past its deadline, the timeout job was lost; any
// state read repairs it by auto-picking.
const CAPTAIN_PICK_STALL_MS = 5000;

// If match creation has made no progress for this long, retry it inline.
const CAPTAIN_PICK_FINALIZE_STALL_MS = 60 * 1000;

const FINALIZE_LOCK_SECONDS = 120;

// How long to wait before trying again to resolve a failed match creation
// that could not be resolved safely yet.
export const FINALIZE_RECOVERY_DELAY_MS = 60 * 1000;

export const CAPTAIN_PICK_FINALIZE_ATTEMPTS = 8;

const DEFAULT_ELO = 5000;

export function getCaptainPickTimeoutJobId(
  confirmationId: string,
  pickIndex: number,
  deadline: string,
) {
  return `matchmaking.captain-pick.${confirmationId}.${pickIndex}.${new Date(deadline).getTime()}`;
}

export function getCaptainPickFinalizeJobId(confirmationId: string) {
  return `matchmaking.captain-pick-finalize.${confirmationId}`;
}

// Set once the draft's match shell is confirmed to exist (and to be ours).
export function getCaptainPickShellKey(confirmationId: string) {
  return `${getCaptainPickDraftCacheKey(confirmationId)}:match-shell`;
}

@Injectable()
export class CaptainPickService {
  public redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly settings: CaptainPickSettingsService,
    @InjectQueue(MatchmakingQueues.Matchmaking) private readonly queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  private static readonly CREATE_SCRIPT = `
    if redis.call('EXISTS', KEYS[1]) == 1 then
      return 0
    end
    redis.call('HSET', KEYS[1], 'state', ARGV[1], 'version', 1)
    redis.call('EXPIRE', KEYS[1], ARGV[2])
    return 1
  `;

  private static readonly COMPARE_AND_SET_SCRIPT = `
    if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then
      return 0
    end
    redis.call('HSET', KEYS[1], 'state', ARGV[2], 'version', tonumber(ARGV[1]) + 1)
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return 1
  `;

  private static readonly DELETE_IF_EQUAL_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;

  public async getActiveDraftId(steamId: string): Promise<string | null> {
    const draftId = await this.redis.get(getCaptainPickPlayerCacheKey(steamId));

    if (!draftId) {
      return null;
    }

    // A draft whose match could not be created has released its players,
    // even if a crash left their keys behind.
    const state = await this.getState(draftId);
    if (!state || state.phase === "Failed") {
      return null;
    }

    return draftId;
  }

  public async hasDraft(confirmationId: string): Promise<boolean> {
    return (
      (await this.redis.exists(getCaptainPickDraftCacheKey(confirmationId))) ===
      1
    );
  }

  public async getState(
    confirmationId: string,
  ): Promise<CaptainPickState | null> {
    return (await this.readState(confirmationId))?.state ?? null;
  }

  /**
   * Called exactly once per confirmation, by whoever won the 10/10 claim (or
   * by the ready-check job recovering a claim that never got this far).
   * Safe to call again: an existing draft is left untouched.
   */
  public async startDraft(confirmationId: string): Promise<void> {
    if (await this.hasDraft(confirmationId)) {
      await this.publishState(confirmationId);
      return;
    }

    const confirmation = await this.redis.hgetall(
      getMatchmakingConformationCacheKey(confirmationId),
    );

    const queued: Array<{
      steam_id: string;
      lobbyId: string;
      joinedAt: string;
    }> = JSON.parse(confirmation.participants || "[]");

    if (queued.length !== CAPTAIN_PICK_PLAYER_COUNT || !confirmation.region) {
      throw new Error(
        `captain pick ${confirmationId} has ${queued.length} participants, cannot start a draft`,
      );
    }

    const participants = await this.loadParticipants(queued);

    const { captains } = selectCaptains(participants);
    const coinFlip: CaptainPickCoinFlip | null =
      captains[0].elo === captains[1].elo
        ? (randomInt(2) as CaptainPickCoinFlip)
        : null;

    const draft = createCaptainPickDraft(participants, coinFlip ?? undefined);
    const { pickSeconds } = await this.settings.getSettings();
    const now = new Date();
    const timer = startCaptainPickTimer(now, pickSeconds);

    const state: CaptainPickState = {
      confirmationId,
      region: confirmation.region,
      phase: "Drafting",
      participants,
      draft,
      coinFlip,
      timer: {
        startedAt: timer.startedAt.toISOString(),
        timerSeconds: timer.timerSeconds,
        deadline: timer.deadline.toISOString(),
      },
      pickedAt: [],
      // The one match this draft becomes, fixed from the start.
      matchId: uuidv4(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    // Reverse keys and the first timeout go in before the state itself, so a
    // crash can never leave a draft that nobody can find or that never ticks.
    await this.setPlayerKeys(state);
    await this.enqueueTimeout(state);

    const created = await this.redis.eval(
      CaptainPickService.CREATE_SCRIPT,
      1,
      getCaptainPickDraftCacheKey(confirmationId),
      JSON.stringify(state),
      CAPTAIN_PICK_STATE_TTL_SECONDS,
    );

    if (created !== 1) {
      return;
    }

    this.logger.log(
      `[captain-pick] ${confirmationId} drafting: captains ${state.draft.captains[1].steam_id} (first pick, ${state.draft.firstPickReason}) vs ${state.draft.captains[2].steam_id}`,
    );

    // Best effort: a failure here only delays the shell (every later publish
    // retries it, and finalize() creates the match anyway).
    await this.ensureMatchShell(confirmationId).catch((error) =>
      this.logger.warn(
        `[captain-pick] ${confirmationId} match shell not created yet: ${(error as Error)?.message}`,
      ),
    );

    await this.publishState(confirmationId);
  }

  /**
   * Makes sure this draft's match exists as an ordinary Competitive match
   * shell (PickingPlayers, empty lineups) under the draft's fixed id, and
   * records the matchId -> draft mapping. Idempotent and safe to race: the
   * fixed id makes a second insert fail, and whatever exists is inspected
   * first. A foreign match under the id is never touched; a canceled one is
   * left alone (an admin canceling it ends the draft through the normal
   * end-of-match cleanup). Never changes the match status.
   * Returns whether the shell is ready.
   */
  public async ensureMatchShell(confirmationId: string): Promise<boolean> {
    const state = await this.getState(confirmationId);

    if (
      !state?.matchId ||
      (state.phase !== "Drafting" && state.phase !== "CreatingMatch")
    ) {
      return false;
    }

    if (await this.redis.get(getCaptainPickShellKey(confirmationId))) {
      return true;
    }

    let inspection = await this.inspectMatch(state);

    if (inspection.kind === "missing") {
      await this.createMatch(state);
      inspection = await this.inspectMatch(state);
    }

    if (inspection.kind === "foreign") {
      this.logger.error(
        `[captain-pick] ${confirmationId} match ${state.matchId} does not look like this draft's match (${inspection.reason}); leaving it untouched`,
      );
      return false;
    }

    if (inspection.kind === "missing" || inspection.kind === "canceled") {
      return false;
    }

    await this.redis.set(
      getMatchConfirmationKey(state.matchId),
      confirmationId,
    );
    await this.redis.set(
      getCaptainPickShellKey(confirmationId),
      state.matchId,
      "EX",
      CAPTAIN_PICK_STATE_TTL_SECONDS,
    );

    return true;
  }

  public async pick(
    confirmationId: string,
    actorSteamId: string,
    targetSteamId: string,
    expectedPickIndex?: number,
  ): Promise<void> {
    const { pickSeconds } = await this.settings.getSettings();

    const result = await this.transition(confirmationId, (state) => {
      if (state.phase !== "Drafting" || state.draft.pickIndex === null) {
        throw new CaptainPickActionError(
          "The draft is no longer taking picks.",
        );
      }

      const actor = state.participants.find(
        (participant) => participant.steam_id === actorSteamId,
      );
      if (!actor) {
        throw new CaptainPickActionError("You are not in this draft.");
      }

      if (
        expectedPickIndex !== undefined &&
        expectedPickIndex !== state.draft.pickIndex
      ) {
        throw new CaptainPickActionError("That pick has already been made.");
      }

      const lineup = getPickingLineup(state.draft.pickIndex);
      if (!lineup || state.draft.captains[lineup].steam_id !== actorSteamId) {
        throw new CaptainPickActionError("It is not your turn to pick.");
      }

      if (
        !state.timer ||
        Date.now() >
          new Date(state.timer.deadline).getTime() +
            CAPTAIN_PICK_MANUAL_GRACE_MS
      ) {
        throw new CaptainPickActionError("Time ran out for this pick.");
      }

      if (
        !state.draft.available.some(
          (participant) => participant.steam_id === targetSteamId,
        )
      ) {
        throw new CaptainPickActionError("That player can't be picked.");
      }

      return this.advance(state, targetSteamId, false, pickSeconds);
    });

    await this.afterTransition(result);
  }

  /**
   * Timeout job for one specific pick. Does nothing unless that exact pick
   * (same index, same deadline) is still waiting.
   */
  public async handleTimeout(
    confirmationId: string,
    pickIndex: number,
    deadline: string,
  ): Promise<void> {
    const { pickSeconds } = await this.settings.getSettings();
    let early = false;

    const result = await this.transition(confirmationId, (state) => {
      if (
        state.phase !== "Drafting" ||
        state.draft.pickIndex !== pickIndex ||
        state.timer?.deadline !== deadline
      ) {
        return null;
      }

      if (
        Date.now() <
        new Date(deadline).getTime() - CAPTAIN_PICK_TIMEOUT_EARLY_TOLERANCE_MS
      ) {
        early = true;
        return null;
      }

      return this.advance(
        state,
        selectAutoPick(state.draft.available).steam_id,
        true,
        pickSeconds,
      );
    });

    if (early && result.state) {
      await this.enqueueTimeout(result.state, `.retry-${Date.now()}`);
      return;
    }

    await this.afterTransition(result);
  }

  /**
   * Creates the ordinary Competitive match for locked teams.
   *
   * Write sequence (each numbered step is its own Postgres transaction):
   *   1. insert_matches_one: match_options + match (+ its two empty lineups
   *      via tbi_match/tai_match) with the pre-generated id -- normally
   *      already done when the draft started (ensureMatchShell)
   *   2. lineup 1 players, one insert   3. lineup 2 players, one insert
   *   4. captain flag per lineup        5. status Live (-> map veto)
   *   6. Redis: confirmation matchId, matches:confirmation key, MatchCreated
   * So a crash can leave: nothing, a match with no/one filled lineup, a
   * filled match still in PickingPlayers, or a started match Redis doesn't
   * know about yet. Every step checks what exists first, so a retry resumes
   * from wherever it stopped and always converges on the one fixed-id match.
   */
  public async finalize(confirmationId: string): Promise<void> {
    await this.withFinalizeLock(confirmationId, async () => {
      const state = await this.getState(confirmationId);

      if (!state || state.phase !== "CreatingMatch" || !state.matchId) {
        return;
      }

      assertFinalTeams(state);

      let inspection = await this.inspectMatch(state);

      if (inspection.kind === "missing") {
        await this.createMatch(state);
        inspection = await this.inspectMatch(state);
      }

      if (inspection.kind === "missing") {
        throw new Error(
          `captain pick ${confirmationId} match ${state.matchId} was not created`,
        );
      }

      if (inspection.kind === "foreign" || inspection.kind === "canceled") {
        throw new Error(
          `captain pick ${confirmationId} match ${state.matchId} cannot be completed: ${inspection.reason}`,
        );
      }

      await this.ensureLineups(state, inspection.match);

      inspection = await this.inspectMatch(state);

      if (
        inspection.kind === "partial" &&
        inspection.lineupsComplete &&
        inspection.match.status === "PickingPlayers"
      ) {
        // The same transition Standard matchmaking uses: with no map yet the
        // matches trigger turns this into the normal map veto.
        await this.matchAssistant.updateMatchStatus(state.matchId, "Live");
        inspection = await this.inspectMatch(state);
      }

      if (inspection.kind !== "complete") {
        throw new Error(
          `captain pick ${confirmationId} match ${state.matchId} is incomplete: ${
            "reason" in inspection ? inspection.reason : inspection.kind
          }`,
        );
      }

      await this.recordMatchCreated(state);
    });
  }

  /**
   * Every normal attempt at creating the match failed. What happens next
   * depends on what actually exists under the fixed match id:
   *   - a complete, started match: that IS the match; record it (success)
   *   - nothing: release everyone with a "please queue again" message
   *   - an incomplete match: cancel it first, confirm it is Canceled, and
   *     only then release everyone
   *   - anything unexpected, or a step that fails: keep everyone committed
   *     and throw, so the caller retries later. Players are never released
   *     while a real match could still exist.
   * No penalty and no automatic requeue in any case.
   */
  public async resolveFinalizeFailure(
    confirmationId: string,
    reason: unknown,
  ): Promise<void> {
    await this.withFinalizeLock(confirmationId, async () => {
      const state = await this.getState(confirmationId);

      if (!state || state.phase !== "CreatingMatch" || !state.matchId) {
        return;
      }

      const inspection = await this.inspectMatch(state);

      switch (inspection.kind) {
        case "complete":
          await this.ensureLineups(state, inspection.match);
          await this.recordMatchCreated(state);
          this.logger.warn(
            `[captain-pick] ${confirmationId} recovered existing match ${state.matchId} after failed attempts`,
          );
          return;
        case "missing":
        case "canceled":
          await this.releaseAfterFailure(state, reason);
          return;
        case "partial": {
          this.logger.warn(
            `[captain-pick] ${confirmationId} canceling incomplete match ${state.matchId}: ${inspection.reason}`,
          );
          await this.matchAssistant.updateMatchStatus(
            state.matchId,
            "Canceled",
          );

          const after = await this.inspectMatch(state);
          if (after.kind !== "canceled") {
            throw new Error(
              `captain pick ${confirmationId} match ${state.matchId} is still ${after.kind} after canceling`,
            );
          }

          await this.releaseAfterFailure(state, reason);
          return;
        }
        case "foreign":
          throw new Error(
            `captain pick ${confirmationId} match ${state.matchId} does not look like this draft's match (${inspection.reason}); leaving it and the players untouched`,
          );
      }
    });
  }

  /**
   * Called when the finalize job has used up its attempts. Resolves the
   * failure if it safely can; otherwise keeps the draft (and its players)
   * alive and tries again later instead of releasing anyone.
   */
  public async handleFinalizeExhausted(
    confirmationId: string,
    reason: unknown,
  ): Promise<void> {
    try {
      await this.resolveFinalizeFailure(confirmationId, reason);
    } catch (error) {
      this.logger.error(
        `[captain-pick] ${confirmationId} could not resolve failed match creation yet, retrying in ${FINALIZE_RECOVERY_DELAY_MS / 1000}s`,
        error,
      );
      await this.keepAlive(confirmationId);
      await this.queue.add(
        "CaptainPickFinalize",
        { confirmationId, recovery: true },
        {
          delay: FINALIZE_RECOVERY_DELAY_MS,
          jobId: `${getCaptainPickFinalizeJobId(confirmationId)}.recovery-${Date.now()}`,
        },
      );
    }
  }

  private async recordMatchCreated(state: CaptainPickState) {
    const { confirmationId, matchId } = state;

    await this.redis.hset(
      getMatchmakingConformationCacheKey(confirmationId),
      "matchId",
      matchId,
    );
    await this.redis.set(getMatchConfirmationKey(matchId), confirmationId);

    const result = await this.transition(confirmationId, (current) => {
      if (current.phase !== "CreatingMatch") {
        return null;
      }
      return {
        ...current,
        phase: "MatchCreated",
        updatedAt: new Date().toISOString(),
      };
    });

    if (result.changed) {
      this.logger.log(
        `[captain-pick] ${confirmationId} created match ${matchId}`,
      );
    }

    await this.afterTransition(result);
  }

  private async withFinalizeLock(
    confirmationId: string,
    run: () => Promise<void>,
  ) {
    const lockKey = `${getCaptainPickDraftCacheKey(confirmationId)}:finalize-lock`;
    const locked = await this.redis.set(
      lockKey,
      1,
      "EX",
      FINALIZE_LOCK_SECONDS,
      "NX",
    );

    if (!locked) {
      throw new CaptainPickFinalizeBusyError(confirmationId);
    }

    try {
      await run();
    } finally {
      await this.redis.del(lockKey);
    }
  }

  // Keeps a draft whose match creation is still being resolved from expiring
  // (and so releasing its players) in the meantime.
  private async keepAlive(confirmationId: string) {
    const state = await this.getState(confirmationId);
    if (!state) {
      return;
    }
    await this.redis.expire(
      getCaptainPickDraftCacheKey(confirmationId),
      CAPTAIN_PICK_STATE_TTL_SECONDS,
    );
    await this.refreshPlayerKeys(state);
  }

  /**
   * Only reached once no match exists or it is confirmed Canceled. Nobody is
   * punished and the other nine are not silently requeued; everyone is
   * released and told to queue again.
   */
  private async releaseAfterFailure(state: CaptainPickState, reason: unknown) {
    const confirmationId = state.confirmationId;
    const result = await this.transition(confirmationId, (current) => {
      if (current.phase !== "CreatingMatch") {
        return null;
      }
      return {
        ...current,
        phase: "Failed",
        updatedAt: new Date().toISOString(),
      };
    });

    if (!result.changed) {
      return;
    }

    this.logger.error(
      `[captain-pick] ${confirmationId} could not create match ${state.matchId}, releasing players`,
      reason,
    );

    for (const participant of state.participants) {
      await this.redis.hdel(
        getMatchmakingLobbyDetailsCacheKey(participant.lobbyId),
        "details",
        "confirmationId",
      );
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: participant.steam_id,
          event: "matchmaking:details",
          data: {},
        }),
      );
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: participant.steam_id,
          event: "matchmaking:error",
          data: {
            message:
              "The Captain Pick match could not be created. Please queue again.",
          },
        }),
      );
    }

    await this.redis.del(getMatchmakingConformationCacheKey(confirmationId));
    await this.redis.del(
      `${getMatchmakingConformationCacheKey(confirmationId)}:confirmed`,
    );
    await this.cleanup(confirmationId);
  }

  private async removeMatchMapping(state: CaptainPickState) {
    if (state.matchId) {
      // Only our own mapping, never one pointing at another confirmation.
      await this.redis.eval(
        CaptainPickService.DELETE_IF_EQUAL_SCRIPT,
        1,
        getMatchConfirmationKey(state.matchId),
        state.confirmationId,
      );
    }
    await this.redis.del(getCaptainPickShellKey(state.confirmationId));
  }

  /**
   * Whether a match is an active Captain Pick draft's match (players still
   * being picked or seated), and whether the given player is one of that
   * draft's ten. Read from the server's own matchId -> draft mapping and
   * draft state; nothing comes from the client but the match id.
   */
  public async getMatchDraftStatus(
    matchId: string,
    steamId: string | null,
  ): Promise<{ active: boolean; participant: boolean }> {
    const draftId = matchId
      ? await this.redis.get(getMatchConfirmationKey(matchId))
      : null;
    const state = draftId ? await this.getState(draftId) : null;

    const active =
      !!state &&
      state.matchId === matchId &&
      (state.phase === "Drafting" || state.phase === "CreatingMatch");

    return {
      active,
      participant:
        active &&
        !!steamId &&
        state.participants.some(
          (participant) => participant.steam_id === String(steamId),
        ),
    };
  }

  /**
   * Spectator DTO only: never return the confirmation or raw Redis state.
   * The pick clock is public (the same deadline every participant sees) and
   * carries the server's time so viewers can correct their own clock.
   */
  public async getSpectatorProgress(matchId: string) {
    const inactive = { matchId, active: false, completed: false, progress: null as null };
    const draftId = await this.redis.get(getMatchConfirmationKey(matchId));
    const state = draftId ? await this.getState(draftId) : null;
    if (!state || state.matchId !== matchId ||
      await this.redis.get(getCaptainPickShellKey(draftId)) !== matchId) return inactive;
    const active = state.phase === "Drafting" || state.phase === "CreatingMatch";
    if (!active) return { ...inactive, completed: state.phase === "MatchCreated" };
    const pickingLineup = state.phase === "Drafting" && state.draft.pickIndex !== null
      ? getPickingLineup(state.draft.pickIndex) : null;
    return {
      matchId, active, completed: false,
      progress: {
        phase: state.phase,
        captains: { 1: state.draft.captains[1].steam_id, 2: state.draft.captains[2].steam_id },
        participants: state.participants.map(({ steam_id, name, avatar_url, elo }) =>
          ({ steam_id, name, avatar_url, elo })),
        lineups: { 1: [...state.draft.lineups[1]], 2: [...state.draft.lineups[2]] },
        available: state.draft.available.map(({ steam_id }) => steam_id),
        pickIndex: state.phase === "Drafting" ? state.draft.pickIndex : null,
        pickOrder: getManualPickOrder(),
        pickingLineup,
        serverNow: new Date().toISOString(),
        deadline: state.phase === "Drafting" ? (state.timer?.deadline ?? null) : null,
        timerSeconds: state.phase === "Drafting" ? (state.timer?.timerSeconds ?? null) : null,
      },
    };
  }

  private async notifySpectators(matchId: string | null) {
    if (!matchId) return;
    // Only an invalidation, not another state store. Each API pod reads Redis.
    await this.redis.publish("captain-pick-progress", JSON.stringify({ matchId })).catch((error) =>
      this.logger.warn("captain pick spectator notification failed: " + error.message),
    );
  }

  /**
   * Removes the draft and the reverse player keys that still point at it.
   * Only called once the confirmation itself is being removed.
   */
  public async cleanup(confirmationId: string): Promise<void> {
    const state = await this.getState(confirmationId);

    if (state) {
      // Still picking means the match ended under the draft: the only way
      // is an admin canceling (or deleting) it. Tell the players why they
      // are back at /play. A failed creation is Failed by now and has its
      // own message; a normal end is MatchCreated.
      if (state.phase === "Drafting") {
        for (const participant of state.participants) {
          await this.redis.publish(
            "send-message-to-steam-id",
            JSON.stringify({
              steamId: participant.steam_id,
              event: "matchmaking:error",
              data: {
                message: "The Captain Pick match was canceled by an admin.",
              },
            }),
          );
        }
      }

      for (const participant of state.participants) {
        const released = await this.redis.eval(
          CaptainPickService.DELETE_IF_EQUAL_SCRIPT,
          1,
          getCaptainPickPlayerCacheKey(participant.steam_id),
          confirmationId,
        );

        // Lobby cleanup skipped the usual empty update while the player was
        // committed; send it now that the draft is over.
        if (released === 1) {
          await this.redis.publish(
            "send-message-to-steam-id",
            JSON.stringify({
              steamId: participant.steam_id,
              event: "matchmaking:details",
              data: {},
            }),
          );
        }
      }

      await this.removeMatchMapping(state);
    }

    await this.redis.del(getCaptainPickDraftCacheKey(confirmationId));
    await this.notifySpectators(state?.matchId ?? null);
  }

  /**
   * Public view of a draft. No Redis internals. The match id is shown once
   * the match exists: from the moment its shell is created (so the draft
   * can use the real Match Chat), not only once the teams are seated.
   */
  public toPublicState(state: CaptainPickState, shellReady = false) {
    const pickIndex = state.draft.pickIndex;
    const pickingLineup =
      state.phase === "Drafting" && pickIndex !== null
        ? getPickingLineup(pickIndex)
        : null;

    return {
      draftId: state.confirmationId,
      phase: state.phase,
      region: state.region,
      serverNow: new Date().toISOString(),
      pickOrder: getManualPickOrder(),
      pickIndex: state.phase === "Drafting" ? pickIndex : null,
      pickingLineup,
      pickingCaptainSteamId: pickingLineup
        ? state.draft.captains[pickingLineup].steam_id
        : null,
      deadline: state.phase === "Drafting" ? state.timer?.deadline : null,
      timerSeconds:
        state.phase === "Drafting" ? state.timer?.timerSeconds : null,
      firstPickLineup: 1 as CaptainPickLineup,
      firstPickReason: state.draft.firstPickReason,
      captains: {
        1: state.draft.captains[1].steam_id,
        2: state.draft.captains[2].steam_id,
      },
      participants: state.participants.map(
        ({ steam_id, name, avatar_url, elo }) => ({
          steam_id,
          name,
          avatar_url,
          elo,
        }),
      ),
      lineups: state.draft.lineups,
      available: state.draft.available.map(({ steam_id }) => steam_id),
      picks: state.draft.selections.map((selection) => ({
        ...selection,
        captain_steam_id: state.draft.captains[selection.lineup].steam_id,
        at: state.pickedAt[selection.pickIndex] ?? null,
      })),
      matchId:
        state.phase === "MatchCreated" ||
        (shellReady &&
          (state.phase === "Drafting" || state.phase === "CreatingMatch"))
          ? state.matchId
          : null,
    };
  }

  /**
   * Sends the current draft to its participants (or just the given ones) on
   * the same matchmaking:details event the ready check uses, so a reconnect
   * or F5 rebuilds the screen from Redis alone.
   */
  public async publishState(
    confirmationId: string,
    onlySteamIds?: Array<string>,
  ): Promise<void> {
    const state = await this.getState(confirmationId);

    if (!state) {
      return;
    }

    this.repairStall(state);

    const confirmation = await this.redis.hgetall(
      getMatchmakingConformationCacheKey(confirmationId),
    );
    const shellReady = !!(await this.redis.get(
      getCaptainPickShellKey(confirmationId),
    ));
    const captainPick = this.toPublicState(state, shellReady);
    if (shellReady) await this.notifySpectators(state.matchId);

    // Retries a shell that could not be created yet, off the publish path so
    // picks never wait on Postgres; announces the match id once it exists.
    if (
      !shellReady &&
      (state.phase === "Drafting" || state.phase === "CreatingMatch")
    ) {
      void this.ensureMatchShell(confirmationId)
        .then((ready) => (ready ? this.publishState(confirmationId) : null))
        .catch((error) =>
          this.logger.warn(
            `[captain-pick] ${confirmationId} match shell retry failed: ${(error as Error)?.message}`,
          ),
        );
    }

    for (const participant of state.participants) {
      if (onlySteamIds && !onlySteamIds.includes(participant.steam_id)) {
        continue;
      }

      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId: participant.steam_id,
          event: "matchmaking:details",
          data: {
            confirmation: {
              type: "Competitive",
              variant: "CaptainPick",
              region: state.region,
              // The ready check/matchmaking UI routes to the match page as
              // soon as this is set, so it stays empty until the teams are
              // seated. The draft screen reads captainPick.matchId instead.
              matchId:
                state.phase === "MatchCreated"
                  ? (state.matchId ?? undefined)
                  : undefined,
              expiresAt: confirmation.expiresAt,
              confirmationId,
              confirmed: state.participants.length,
              players: state.participants.length,
              isReady: participant.steam_id,
              captainPick,
            },
          },
        }),
      );
    }
  }

  private advance(
    state: CaptainPickState,
    targetSteamId: string,
    auto: boolean,
    pickSeconds: number,
  ): CaptainPickState {
    const pickIndex = state.draft.pickIndex as number;
    const now = new Date();

    let draft: CaptainPickDraft<CaptainPickDraftParticipant>;
    try {
      draft = applyCaptainPick(state.draft, targetSteamId, { auto });
    } catch (error) {
      if (error instanceof CaptainPickRuleError) {
        throw new CaptainPickActionError("That player can't be picked.");
      }
      throw error;
    }

    const pickedAt = [...state.pickedAt];
    pickedAt[pickIndex] = now.toISOString();

    if (draft.pickIndex === null) {
      const next: CaptainPickState = {
        ...state,
        draft,
        pickedAt,
        phase: "CreatingMatch",
        timer: null,
        // The id fixed at 10/10 (a draft started before that existed gets
        // one now).
        matchId: state.matchId ?? uuidv4(),
        updatedAt: now.toISOString(),
      };
      assertFinalTeams(next);
      return next;
    }

    const timer = startCaptainPickTimer(now, pickSeconds);

    return {
      ...state,
      draft,
      pickedAt,
      timer: {
        startedAt: timer.startedAt.toISOString(),
        timerSeconds: timer.timerSeconds,
        deadline: timer.deadline.toISOString(),
      },
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Optimistic compare-and-swap. `mutate` runs against the latest committed
   * state; returning null means "nothing to do", throwing rejects the action.
   * Scheduling for the resulting state happens before the commit so a crash
   * right after it cannot leave the draft without a timer or finalizer.
   */
  private async transition(
    confirmationId: string,
    mutate: (state: CaptainPickState) => CaptainPickState | null,
  ): Promise<{ state: CaptainPickState | null; changed: boolean }> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await this.readState(confirmationId);

      if (!current) {
        throw new CaptainPickActionError("This draft no longer exists.");
      }

      const next = mutate(structuredClone(current.state));

      if (!next) {
        return { state: current.state, changed: false };
      }

      await this.scheduleFor(next);

      const committed = await this.redis.eval(
        CaptainPickService.COMPARE_AND_SET_SCRIPT,
        1,
        getCaptainPickDraftCacheKey(confirmationId),
        String(current.version),
        JSON.stringify(next),
        CAPTAIN_PICK_STATE_TTL_SECONDS,
      );

      if (committed === 1) {
        return { state: next, changed: true };
      }
    }

    throw new Error(`captain pick ${confirmationId} is too contended`);
  }

  private async afterTransition(result: {
    state: CaptainPickState | null;
    changed: boolean;
  }) {
    if (!result.changed || !result.state) {
      return;
    }

    await this.refreshPlayerKeys(result.state);
    await this.publishState(result.state.confirmationId);
  }

  private async scheduleFor(state: CaptainPickState) {
    if (state.phase === "Drafting") {
      await this.enqueueTimeout(state);
    } else if (state.phase === "CreatingMatch") {
      await this.enqueueFinalize(state.confirmationId);
    }
  }

  private async enqueueTimeout(state: CaptainPickState, suffix = "") {
    if (!state.timer || state.draft.pickIndex === null) {
      return;
    }

    await this.queue.add(
      "CaptainPickTimeout",
      {
        confirmationId: state.confirmationId,
        pickIndex: state.draft.pickIndex,
        deadline: state.timer.deadline,
      },
      {
        delay: Math.max(
          0,
          new Date(state.timer.deadline).getTime() - Date.now(),
        ),
        jobId: `${getCaptainPickTimeoutJobId(
          state.confirmationId,
          state.draft.pickIndex,
          state.timer.deadline,
        )}${suffix}`,
      },
    );
  }

  private async enqueueFinalize(confirmationId: string) {
    await this.queue.add(
      "CaptainPickFinalize",
      { confirmationId },
      {
        jobId: getCaptainPickFinalizeJobId(confirmationId),
        attempts: CAPTAIN_PICK_FINALIZE_ATTEMPTS,
        backoff: { type: "exponential", delay: 2000 },
      },
    );
  }

  /**
   * Self-healing for lost jobs: any state read (reconnect, publish) finishes
   * an overdue pick or retries a stalled match creation.
   */
  private repairStall(state: CaptainPickState) {
    const now = Date.now();

    if (
      state.phase === "Drafting" &&
      state.timer &&
      state.draft.pickIndex !== null &&
      now > new Date(state.timer.deadline).getTime() + CAPTAIN_PICK_STALL_MS
    ) {
      void this.handleTimeout(
        state.confirmationId,
        state.draft.pickIndex,
        state.timer.deadline,
      ).catch((error) =>
        this.logger.warn(
          `[captain-pick] ${state.confirmationId} stall repair failed: ${(error as Error)?.message}`,
        ),
      );
    }

    if (
      state.phase === "CreatingMatch" &&
      now > new Date(state.updatedAt).getTime() + CAPTAIN_PICK_FINALIZE_STALL_MS
    ) {
      void this.finalize(state.confirmationId).catch(() => {
        // Either the job is running it right now or it will retry.
      });
    }
  }

  private async readState(
    confirmationId: string,
  ): Promise<{ state: CaptainPickState; version: number } | null> {
    const { state, version } = await this.redis.hgetall(
      getCaptainPickDraftCacheKey(confirmationId),
    );

    if (!state || !version) {
      return null;
    }

    return { state: JSON.parse(state), version: Number(version) };
  }

  private async setPlayerKeys(state: CaptainPickState) {
    for (const participant of state.participants) {
      await this.redis.set(
        getCaptainPickPlayerCacheKey(participant.steam_id),
        state.confirmationId,
        "EX",
        CAPTAIN_PICK_STATE_TTL_SECONDS,
      );
    }
  }

  private async refreshPlayerKeys(state: CaptainPickState) {
    for (const participant of state.participants) {
      await this.redis.expire(
        getCaptainPickPlayerCacheKey(participant.steam_id),
        CAPTAIN_PICK_STATE_TTL_SECONDS,
      );
    }
  }

  // Fresh, server-side Competitive ELO: same source and default as the
  // Standard queue (setLobbyDetails), never anything a client sent.
  private async loadParticipants(
    queued: Array<{ steam_id: string; lobbyId: string; joinedAt: string }>,
  ): Promise<Array<CaptainPickDraftParticipant>> {
    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: { _in: queued.map(({ steam_id }) => steam_id) },
          },
        },
        steam_id: true,
        name: true,
        avatar_url: true,
        elo: true,
      },
    });

    const bySteamId = new Map(
      players.map((player) => [String(player.steam_id), player]),
    );

    return queued.map(({ steam_id, lobbyId, joinedAt }) => {
      const player = bySteamId.get(String(steam_id));
      const rawElo = (player?.elo as Record<string, unknown> | undefined)
        ?.competitive;
      const elo =
        rawElo === null || rawElo === undefined ? DEFAULT_ELO : Number(rawElo);

      return {
        steam_id: String(steam_id),
        lobbyId,
        joinedAt: new Date(joinedAt).toISOString(),
        name: player?.name ?? String(steam_id),
        avatar_url: player?.avatar_url ?? null,
        elo: Number.isFinite(elo) ? elo : DEFAULT_ELO,
      };
    });
  }

  // Step 1: match_options + match in one insert, with the fixed id. A
  // duplicate-key error means an earlier attempt already inserted it, which
  // the caller's re-inspection picks up.
  private async createMatch(state: CaptainPickState) {
    const { mapPoolType, options } = getMatchmakingMatchSetup(
      "Competitive",
      state.region,
    );

    try {
      await this.matchAssistant.createMatchBasedOnType(
        "Competitive",
        mapPoolType,
        { ...options, id: state.matchId as string },
      );
    } catch (error) {
      if ((await this.inspectMatch(state)).kind === "missing") {
        throw error;
      }
    }
  }

  /**
   * What exists under this draft's fixed match id. "complete" means it is
   * provably this draft's match and already handed to the normal flow:
   * Competitive with the Standard matchmaking options, the active
   * Competitive map pool with the normal veto, 5stack source, no draft link,
   * exactly the drafted players on their drafted sides, and past
   * PickingPlayers. A match that is ours but not there yet is "partial";
   * one that doesn't match these expectations at all is "foreign" and is
   * never touched.
   */
  public async inspectMatch(state: CaptainPickState): Promise<MatchInspection> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: state.matchId as string },
        id: true,
        status: true,
        source: true,
        region: true,
        lineup_1_id: true,
        lineup_2_id: true,
        options: {
          type: true,
          mr: true,
          best_of: true,
          knife_round: true,
          overtime: true,
          timeout_setting: true,
          map_veto: true,
          map_pool: {
            type: true,
          },
        },
        draft_games: {
          id: true,
        },
        lineup_1: {
          lineup_players: {
            steam_id: true,
            captain: true,
          },
        },
        lineup_2: {
          lineup_players: {
            steam_id: true,
            captain: true,
          },
        },
      },
    });

    if (!match) {
      return { kind: "missing" };
    }

    const summary: InspectedMatch = {
      id: match.id,
      status: match.status,
      lineupIds: { 1: match.lineup_1_id, 2: match.lineup_2_id },
    };

    const { options: expected } = getMatchmakingMatchSetup(
      "Competitive",
      state.region,
    );
    const options = match.options;
    const mismatch = [
      options?.type !== "Competitive" && `type ${options?.type}`,
      match.source !== "5stack" && `source ${match.source}`,
      match.region !== state.region && `region ${match.region}`,
      options?.mr !== expected.mr && `mr ${options?.mr}`,
      options?.best_of !== expected.best_of && `best_of ${options?.best_of}`,
      options?.knife_round !== expected.knife && "knife round",
      options?.overtime !== expected.overtime && "overtime",
      options?.timeout_setting !== expected.timeout_setting &&
        `timeouts ${options?.timeout_setting}`,
      options?.map_veto !== true && "no map veto",
      options?.map_pool?.type !== "Competitive" &&
        `map pool ${options?.map_pool?.type}`,
      (match.draft_games?.length ?? 0) > 0 && "linked to a draft game",
    ].filter(Boolean);

    const seated = {
      1: (match.lineup_1?.lineup_players ?? []).map((p) => ({
        steam_id: String(p.steam_id),
        captain: p.captain,
      })),
      2: (match.lineup_2?.lineup_players ?? []).map((p) => ({
        steam_id: String(p.steam_id),
        captain: p.captain,
      })),
    };

    for (const lineup of [1, 2] as const) {
      const drafted = new Set(state.draft.lineups[lineup]);
      const strangers = seated[lineup].filter((p) => !drafted.has(p.steam_id));
      if (strangers.length > 0) {
        mismatch.push(`unexpected players in lineup ${lineup}`);
      }
    }

    if (mismatch.length > 0) {
      return { kind: "foreign", match: summary, reason: mismatch.join(", ") };
    }

    if (match.status === "Canceled") {
      return { kind: "canceled", match: summary, reason: "match is canceled" };
    }

    const lineupsComplete = ([1, 2] as const).every(
      (lineup) =>
        seated[lineup].length === state.draft.lineups[lineup].length &&
        state.draft.lineups[lineup].every((steamId) =>
          seated[lineup].some((p) => p.steam_id === steamId),
        ),
    );

    if (!lineupsComplete) {
      return {
        kind: "partial",
        match: summary,
        lineupsComplete,
        reason: "lineups are not fully seated",
      };
    }

    if (match.status === "PickingPlayers") {
      return {
        kind: "partial",
        match: summary,
        lineupsComplete,
        reason: "match was never started",
      };
    }

    return { kind: "complete", match: summary };
  }

  // Steps 2-4, each lineup idempotently; also restores the drafted captain.
  private async ensureLineups(state: CaptainPickState, match: InspectedMatch) {
    for (const lineup of [1, 2] as const) {
      await this.ensureLineup(
        match.lineupIds[lineup],
        state.draft.lineups[lineup],
        state.draft.captains[lineup].steam_id,
      );
    }
  }

  /**
   * Seats one drafted team. The whole lineup goes in one insert (one
   * transaction), captain first, so a lineup is either fully seated or empty.
   * The captain is then set explicitly; the lineup trigger clears the flag on
   * everyone else.
   */
  private async ensureLineup(
    lineupId: string,
    steamIds: Array<string>,
    captainSteamId: string,
  ) {
    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: { match_lineup_id: { _eq: lineupId } },
        },
        steam_id: true,
        captain: true,
      },
    });

    const seated = new Set(
      match_lineup_players.map((player) => String(player.steam_id)),
    );

    if (seated.size === 0) {
      await this.hasura.mutation({
        insert_match_lineup_players: {
          __args: {
            objects: steamIds.map((steamId) => ({
              steam_id: steamId,
              match_lineup_id: lineupId,
            })),
          },
          __typename: true,
        },
      });
    } else if (
      seated.size !== steamIds.length ||
      steamIds.some((steamId) => !seated.has(steamId))
    ) {
      throw new Error(
        `lineup ${lineupId} does not match the drafted team, refusing to change it`,
      );
    }

    const captain = match_lineup_players.find(
      (player) => String(player.steam_id) === captainSteamId,
    );

    if (!captain?.captain) {
      await this.hasura.mutation({
        update_match_lineup_players: {
          __args: {
            where: {
              match_lineup_id: { _eq: lineupId },
              steam_id: { _eq: captainSteamId },
            },
            _set: { captain: true },
          },
          __typename: true,
        },
      });
    }
  }
}

/** The locked teams must be exactly the ten participants, 5 and 5. */
export function assertFinalTeams(state: CaptainPickState) {
  const { lineups, captains, available } = state.draft;
  const all = [...lineups[1], ...lineups[2]];
  const participants = new Set(state.participants.map((p) => p.steam_id));

  if (
    available.length !== 0 ||
    lineups[1].length !== CAPTAIN_PICK_TEAM_SIZE ||
    lineups[2].length !== CAPTAIN_PICK_TEAM_SIZE ||
    new Set(all).size !== CAPTAIN_PICK_PLAYER_COUNT ||
    all.some((steamId) => !participants.has(steamId)) ||
    lineups[1][0] !== captains[1].steam_id ||
    lineups[2][0] !== captains[2].steam_id
  ) {
    throw new Error(
      `captain pick ${state.confirmationId} teams are not a valid 5v5`,
    );
  }
}
