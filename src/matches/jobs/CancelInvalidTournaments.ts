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

  // An open tournament that is short of teams at its scheduled start is
  // cancelled, but only after the Free Agent pool has had its say:
  // cancel_invalid_tournaments asks the real draft how many teams the pool would
  // make (and discards the answer), so a Free Agents or Both tournament whose
  // complete teams still exist only as sign-ups is not cancelled for the teams
  // it has not drafted yet. Everything else keeps the old rule.
  async process(): Promise<number> {
    const [row] = await this.postgres.query<
      Array<{ cancelled: number }>
    >(`SELECT public.cancel_invalid_tournaments() AS cancelled`);

    const cancelled = Number(row?.cancelled ?? 0);

    if (cancelled > 0) {
      this.logger.log(
        `${cancelled} tournaments cancelled due to insufficient teams`,
      );
    }

    return cancelled;
  }
}
