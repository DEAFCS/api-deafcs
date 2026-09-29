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
    return this.redis.get(getCaptainPickPlayerCacheKey(steamId));
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
      matchId: null,
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

    await this.publishState(confirmationId);
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
   * Creates the ordinary Competitive match for locked teams. Every step is
   * idempotent (fixed match id, per-lineup inserts), so a retry after any
   * crash converges on the same single match.
   */
  public async finalize(confirmationId: string): Promise<void> {
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
      const state = await this.getState(confirmationId);

      if (!state || state.phase !== "CreatingMatch" || !state.matchId) {
        return;
      }

      assertFinalTeams(state);

      const matchId = state.matchId;
      const lineupIds = await this.ensureMatch(state);

      for (const lineup of [1, 2] as const) {
        await this.ensureLineup(
          lineupIds[lineup],
          state.draft.lineups[lineup],
          state.draft.captains[lineup].steam_id,
        );
      }

      const { matches_by_pk } = await this.hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          status: true,
        },
      });

      if (matches_by_pk?.status === "PickingPlayers") {
        // The same transition Standard matchmaking uses: with no map yet the
        // matches trigger turns this into the normal map veto.
        await this.matchAssistant.updateMatchStatus(matchId, "Live");
      }

      await this.redis.hset(
        getMatchmakingConformationCacheKey(confirmationId),
        "matchId",
        matchId,
      );
      await this.redis.set(`matches:confirmation:${matchId}`, confirmationId);

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

      this.logger.log(
        `[captain-pick] ${confirmationId} created match ${matchId}`,
      );

      await this.afterTransition(result);
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /**
   * Match creation gave up after every retry. Nobody is punished and the
   * other nine are not silently requeued; everyone is released and told to
   * queue again. A partially created match (if any) is only logged.
   */
  public async failFinalize(confirmationId: string, reason: unknown) {
    const result = await this.transition(confirmationId, (state) => {
      if (state.phase !== "CreatingMatch") {
        return null;
      }
      return {
        ...state,
        phase: "Failed",
        updatedAt: new Date().toISOString(),
      };
    });

    const state = result.state;
    if (!result.changed || !state) {
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

  /**
   * Removes the draft and the reverse player keys that still point at it.
   * Only called once the confirmation itself is being removed.
   */
  public async cleanup(confirmationId: string): Promise<void> {
    const state = await this.getState(confirmationId);

    if (state) {
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
    }

    await this.redis.del(getCaptainPickDraftCacheKey(confirmationId));
  }

  /** Public view of a draft. No Redis internals, no unannounced match id. */
  public toPublicState(state: CaptainPickState) {
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
      matchId: state.phase === "MatchCreated" ? state.matchId : null,
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
    const captainPick = this.toPublicState(state);

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
              matchId: captainPick.matchId ?? undefined,
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
        matchId: uuidv4(),
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

  private async ensureMatch(
    state: CaptainPickState,
  ): Promise<Record<CaptainPickLineup, string>> {
    const matchId = state.matchId as string;

    let match = await this.findMatch(matchId);

    if (!match) {
      const { mapPoolType, options } = getMatchmakingMatchSetup(
        "Competitive",
        state.region,
      );

      try {
        match = await this.matchAssistant.createMatchBasedOnType(
          "Competitive",
          mapPoolType,
          { ...options, id: matchId },
        );
      } catch (error) {
        // A concurrent or half-finished earlier attempt may have inserted it.
        match = await this.findMatch(matchId);
        if (!match) {
          throw error;
        }
      }
    }

    return { 1: match.lineup_1_id, 2: match.lineup_2_id };
  }

  private async findMatch(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    return matches_by_pk ?? null;
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
