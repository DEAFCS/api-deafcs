import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { SanctionsService } from "src/sanctions/sanctions.service";
import { HasuraService } from "src/hasura/hasura.service";
import { SYSTEM_STEAM_ID } from "./constants";

const DISCONNECT_BUDGET_SECONDS = 5 * 60;

const LEAVER_BAN_DECAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// stage index (1-based) -> ban duration in ms. Whether ELO is also docked at
// a given stage depends on the violation type -- see applyEloPenalty below.
const LEAVER_BAN_STAGE_DURATIONS_MS = [
  30 * 60 * 1000, // stage 1: 30 min
  2 * 60 * 60 * 1000, // stage 2: 2h
  24 * 60 * 60 * 1000, // stage 3: 24h
  24 * 60 * 60 * 1000, // stage 4+
];

export type LeaverViolationType = "no_show" | "disconnect_timeout";

export interface LeaverBanResult {
  stage: number;
  durationMs: number;
  // no_show: only true at the top stage (repeat pattern). disconnect_timeout
  // (touched the server, then left before start or mid-match): always true,
  // from stage 1.
  applyEloPenalty: boolean;
  sanctionId: string | null;
  // Non-zero only for a no_show violation with a matchId — see
  // apply_no_show_elo_penalty.
  eloChange: number;
}

@Injectable()
export class DisconnectBudgetService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly sanctionsService: SanctionsService,
    private readonly hasura: HasuraService,
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
    // The match this violation happened in/around. A no_show uses it to
    // apply a standalone flat ELO penalty for the no-show themself once it's
    // a repeat pattern (see apply_no_show_elo_penalty); a disconnect_timeout
    // uses it to flag the per-player ELO penalty from stage 1 onward, since
    // they touched the server.
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
    const isTopStage = nextStage >= LEAVER_BAN_STAGE_DURATIONS_MS.length;

    // A no-show never touched the server -- mild, only costs ELO once it's
    // a repeat pattern (top stage). Someone who *did* touch the server
    // (left before start, or mid-match) had a real chance to play, so they
    // lose ELO every single time, from stage 1, regardless of how the
    // match turned out for their team.
    const applyEloPenalty =
      violation === "disconnect_timeout" ? true : isTopStage;

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

    // This still goes through player_sanctions (type: "ban") -- that's
    // what actually enforces the block (is_banned, matchmaking queue-join,
    // the game server's connect-time kick) and none of that changes here.
    // But it's an "Abandoned" violation, not a "Sanction" -- also record it
    // in abandoned_matches (same table/shape MatchAbandoned already
    // writes to) so it shows up under the Abandoned tab on the player's
    // profile instead of Sanctions, and deliberately skip the admin bell
    // notification below: admins asked to be alerted for real (Sanction)
    // bans, not for every automated leaver/no-show.
    await this.hasura.mutation({
      insert_abandoned_matches_one: {
        __args: {
          object: {
            steam_id: steamId,
            match_id: matchId ?? null,
            reason,
            remove_sanction_date: new Date(
              Date.now() + durationMs,
            ).toISOString(),
          },
        },
        __typename: true,
      },
    });

    // Mid-match/touched-server leavers: flag the row now, forcing a flat
    // penalty once the match actually finishes and generate_player_elo_for_match
    // runs -- the match is still being played, so there's no final score to
    // dock ELO from yet.
    if (violation === "disconnect_timeout" && applyEloPenalty && matchId) {
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

    // No-shows: the match is already canceled with no winner, so there's
    // nothing to defer to -- apply the flat penalty immediately, but only
    // once it's a repeat pattern (top stage).
    let eloChange = 0;
    if (violation === "no_show" && applyEloPenalty && matchId) {
      const [row] = await this.postgres.query<Array<{ change: number }>>(
        `SELECT apply_no_show_elo_penalty($1, $2) AS change`,
        [matchId, steamId],
      );
      eloChange = row?.change ?? 0;
    }

    this.logger.log(
      `Automated leaver ban applied steam_id=${steamId} stage=${nextStage} violation=${violation} elo_penalty=${applyEloPenalty} elo_change=${eloChange}`,
    );

    return {
      stage: nextStage,
      durationMs,
      applyEloPenalty,
      sanctionId: id,
      eloChange,
    };
  }
}
