import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelInvalidTournaments extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  // The scheduled start of an open tournament, two steps in this order:
  //
  // 1. A tournament that is short of teams at its start time is cancelled, but
  //    only after the Free Agent pool has had its say: cancel_invalid_tournaments
  //    asks the real draft how many teams the pool would make (and discards the
  //    answer), so a Free Agents or Both tournament whose complete teams still
  //    exist only as sign-ups is not cancelled for teams it has not drafted yet.
  // 2. A version 2 tournament WITHOUT check-in that is still open at its start
  //    time is started (start_due_tournaments): the same transition as the
  //    organizer's Start button, which closes registration, drafts the pool,
  //    seeds and draws the bracket and goes Live. With check-in on, the check-in
  //    job closes registration and CheckForTournamentStart starts it instead.
  async process(): Promise<number> {
    const [cancelledRow] = await this.postgres.query<
      Array<{ cancelled: number }>
    >(`SELECT public.cancel_invalid_tournaments() AS cancelled`);

    const cancelled = Number(cancelledRow?.cancelled ?? 0);

    if (cancelled > 0) {
      this.logger.log(
        `${cancelled} tournaments cancelled due to insufficient teams`,
      );
    }

    const [startedRow] = await this.postgres.query<
      Array<{ started: number }>
    >(`SELECT public.start_due_tournaments() AS started`);

    const started = Number(startedRow?.started ?? 0);

    if (started > 0) {
      this.logger.log(`${started} tournaments started at their scheduled time`);
    }

    return cancelled + started;
  }
}
