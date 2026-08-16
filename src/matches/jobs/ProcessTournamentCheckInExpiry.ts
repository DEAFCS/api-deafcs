import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { PoolClient } from "pg";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

// Closes expired individual-sign-up check-in windows
// (tournaments.individual_check_in_ends_at <= now()). Anyone still
// Registered without a checked_in_at gets marked Removed; that many
// players are promoted off the Waitlist (oldest sign-up first) back to
// Registered with a fresh check-in window of the same configured
// duration -- so newly-promoted players get their own forced overlay too,
// not a free pass. Repeats naturally: each cycle either shrinks the
// waitlist or, once nobody's left to promote (or nobody needed removing),
// clears the window and the round is done.
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ProcessTournamentCheckInExpiry extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const expired = await this.postgres.query<
      Array<{ id: string; individual_check_in_duration_minutes: number | null }>
    >(
      `SELECT id, individual_check_in_duration_minutes
       FROM public.tournaments
       WHERE individual_check_in_ends_at IS NOT NULL
       AND individual_check_in_ends_at <= now()`,
    );

    for (const tournament of expired) {
      try {
        await this.processTournament(
          tournament.id,
          tournament.individual_check_in_duration_minutes ?? 10,
        );
      } catch (error) {
        this.logger.error(
          `[${tournament.id}] failed to process check-in expiry`,
          error,
        );
      }
    }

    return expired.length;
  }

  private async processTournament(
    tournamentId: string,
    durationMinutes: number,
  ): Promise<void> {
    await this.postgres.transaction(async (client) => {
      const removed = await client.query<{ id: string }>(
        `UPDATE public.tournament_individual_signups
         SET status = 'Removed'
         WHERE tournament_id = $1 AND status = 'Registered' AND checked_in_at IS NULL
         RETURNING id`,
        [tournamentId],
      );

      if (removed.rows.length === 0) {
        // Everyone checked in (or there was nobody to check in) --
        // resolved, no promotion needed.
        await client.query(
          `UPDATE public.tournaments SET individual_check_in_ends_at = NULL WHERE id = $1`,
          [tournamentId],
        );
        return;
      }

      const promoted = await this.promoteFromWaitlist(
        client,
        tournamentId,
        removed.rows.length,
      );

      if (promoted === 0) {
        await client.query(
          `UPDATE public.tournaments SET individual_check_in_ends_at = NULL WHERE id = $1`,
          [tournamentId],
        );
        this.logger.log(
          `[${tournamentId}] check-in expired: removed ${removed.rows.length}, no one left on waitlist`,
        );
        return;
      }

      const endsAt = new Date(Date.now() + durationMinutes * 60_000);
      await client.query(
        `UPDATE public.tournaments SET individual_check_in_ends_at = $1 WHERE id = $2`,
        [endsAt, tournamentId],
      );
      this.logger.log(
        `[${tournamentId}] check-in expired: removed ${removed.rows.length}, promoted ${promoted} from waitlist, new window ${durationMinutes}m`,
      );
    });
  }

  private async promoteFromWaitlist(
    client: PoolClient,
    tournamentId: string,
    count: number,
  ): Promise<number> {
    const promoted = await client.query<{ id: string }>(
      `UPDATE public.tournament_individual_signups
       SET status = 'Registered', checked_in_at = NULL
       WHERE id IN (
         SELECT id FROM public.tournament_individual_signups
         WHERE tournament_id = $1 AND status = 'Waitlisted'
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE
       )
       RETURNING id`,
      [tournamentId, count],
    );
    return promoted.rows.length;
  }
}
