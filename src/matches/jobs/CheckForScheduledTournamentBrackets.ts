import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CheckForScheduledTournamentBrackets extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const fifteenMinutesAhead = new Date();
    fifteenMinutesAhead.setMinutes(fifteenMinutesAhead.getMinutes() + 15);

    const rows = await this.postgres.query<{ scheduled_count: number }[]>(
      `
      WITH due_brackets AS (
        SELECT tb.id
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN tournaments t ON t.id = ts.tournament_id
        WHERE tb.match_id IS NULL
          AND tb.finished = false
          AND tb.scheduled_at IS NOT NULL
          AND tb.scheduled_at <= $1::timestamptz
          -- Live tournaments materialize as before. RegistrationClosed
          -- tournaments also materialize once their own scheduled start is
          -- imminent (same 15-minute window as $1) -- this is what gives
          -- round-1 matches their pre-kickoff prep/check-in buffer now that
          -- CheckForTournamentStart no longer flips status to Live early to
          -- get that same effect. Every later round is already covered by
          -- the plain Live branch, since status stays Live from round 1
          -- onward.
          AND (
            t.status = 'Live'
            OR (t.status = 'RegistrationClosed' AND t.start <= $1::timestamptz)
          )
      )
      SELECT COUNT(*)::int AS scheduled_count
      FROM (
        SELECT schedule_tournament_match(tb) AS match_id
        FROM tournament_brackets tb
        INNER JOIN due_brackets db ON db.id = tb.id
      ) scheduled
      WHERE scheduled.match_id IS NOT NULL;
      `,
      [fifteenMinutesAhead.toISOString()],
    );

    const scheduledCount = rows[0]?.scheduled_count ?? 0;

    if (scheduledCount > 0) {
      this.logger.log(
        `${scheduledCount} scheduled tournament brackets started`,
      );
    }

    return scheduledCount;
  }
}
