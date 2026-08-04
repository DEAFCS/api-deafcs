import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { SanctionsService } from "src/sanctions/sanctions.service";

// Reserved player row (see migration 1877000000000_seed_system_player) used
// as the sanctioner for bans issued automatically rather than by an admin.
export const SYSTEM_STEAM_ID = "0";

const DISCONNECT_BUDGET_SECONDS = 5 * 60;

const LEAVER_BAN_DECAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// stage index (1-based) -> ban duration in ms. Stage 4+ additionally carries
// an ELO penalty (see LeaverBanResult.applyEloPenalty).
const LEAVER_BAN_STAGE_DURATIONS_MS = [
  30 * 60 * 1000, // stage 1: 30 min
  2 * 60 * 60 * 1000, // stage 2: 2h
  24 * 60 * 60 * 1000, // stage 3: 24h
  24 * 60 * 60 * 1000, // stage 4+: 24h + ELO penalty
];

export type LeaverViolationType = "no_show" | "disconnect_timeout";

export interface LeaverBanResult {
  stage: number;
  durationMs: number;
  applyEloPenalty: boolean;
  sanctionId: string | null;
}

@Injectable()
export class DisconnectBudgetService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly sanctionsService: SanctionsService,
  ) {}

  /**
   * Cumulative, non-resetting disconnect time for this player in this match:
   * every closed interval plus however long the current disconnect (if any)
   * has run so far.
   */
  public async getRemainingBudgetSeconds(
    matchId: string,
    steamId: string,
  ): Promise<number> {
    const [row] = await this.postgres.query<
      Array<{ used_seconds: string }>
    >(
      `SELECT COALESCE(SUM(
                EXTRACT(EPOCH FROM (COALESCE(reconnected_at, now()) - disconnected_at))
              ), 0) AS used_seconds
         FROM public.match_player_disconnects
        WHERE match_id = $1
          AND steam_id = $2`,
      [matchId, steamId],
    );

    const usedSeconds = Number(row?.used_seconds ?? 0);

    return Math.max(0, DISCONNECT_BUDGET_SECONDS - Math.floor(usedSeconds));
  }

  public async isCurrentlyDisconnected(
    matchId: string,
    steamId: string,
  ): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id
         FROM public.match_player_disconnects
        WHERE match_id = $1
          AND steam_id = $2
          AND reconnected_at IS NULL
        LIMIT 1`,
      [matchId, steamId],
    );

    return rows.length > 0;
  }

  /**
   * Escalates and applies an automated leaver/no-show ban for a player.
   * Stage decays back to 0 after LEAVER_BAN_DECAY_MS with no new violation;
   * a violation inside that window escalates to the next stage instead and
   * pushes the decay deadline out again.
   */
  public async applyLeaverBan(params: {
    steamId: string;
    serverId?: string | null;
    violation: LeaverViolationType;
    // Present when the violation happened inside a specific match — required
    // to flag the per-player ELO penalty for that match. No-show bans (the
    // match never played) omit it since there's no ELO to affect.
    matchId?: string | null;
  }): Promise<LeaverBanResult> {
    const { steamId, serverId, violation, matchId } = params;

    const [player] = await this.postgres.query<
      Array<{
        leaver_ban_stage: number;
        leaver_ban_stage_expires_at: Date | null;
      }>
    >(
      `SELECT leaver_ban_stage, leaver_ban_stage_expires_at
         FROM public.players
        WHERE steam_id = $1`,
      [steamId],
    );

    const decayed =
      !player ||
      !player.leaver_ban_stage_expires_at ||
      player.leaver_ban_stage_expires_at.getTime() < Date.now();

    const currentStage = decayed ? 0 : player.leaver_ban_stage;
    const nextStage = Math.min(
      currentStage + 1,
      LEAVER_BAN_STAGE_DURATIONS_MS.length,
    );
    const durationMs = LEAVER_BAN_STAGE_DURATIONS_MS[nextStage - 1];
    const applyEloPenalty = nextStage >= LEAVER_BAN_STAGE_DURATIONS_MS.length;

    await this.postgres.query(
      `UPDATE public.players
          SET leaver_ban_stage = $2,
              leaver_ban_stage_expires_at = $3
        WHERE steam_id = $1`,
      [steamId, nextStage, new Date(Date.now() + LEAVER_BAN_DECAY_MS)],
    );

    const reason =
      violation === "no_show"
        ? `Did not join the match in time (stage ${nextStage})`
        : `Disconnected without returning in time (stage ${nextStage})`;

    const { id } = await this.sanctionsService.sanctionServerPlayer({
      serverId: serverId ?? null,
      steamId,
      type: "ban",
      reason,
      duration: durationMs,
      sanctionedBySteamId: SYSTEM_STEAM_ID,
    });

    if (applyEloPenalty && matchId) {
      await this.postgres.query(
        `UPDATE public.match_lineup_players mlp
            SET elo_penalty = true
           FROM public.matches m
          WHERE (mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)
            AND m.id = $1
            AND mlp.steam_id = $2`,
        [matchId, steamId],
      );
    }

    this.logger.log(
      `Automated leaver ban applied steam_id=${steamId} stage=${nextStage} violation=${violation} elo_penalty=${applyEloPenalty}`,
    );

    return {
      stage: nextStage,
      durationMs,
      applyEloPenalty,
      sanctionId: id,
    };
  }
}
