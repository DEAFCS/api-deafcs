import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.MatchServers)
export class CheckForTournamentStart extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(): Promise<number> {
    // Exactly now, not 15 minutes early: RegistrationClosed -> Live is meant
    // to mean "the tournament's scheduled start has actually been reached",
    // not "about to start". The 15-minute early-materialization behavior
    // this used to provide (so round-1 matches exist with a prep/check-in
    // buffer before kickoff) is preserved separately in
    // CheckForScheduledTournamentBrackets, which now also fires while still
    // RegistrationClosed -- see that job's comment for why.
    const now = new Date();

    try {
      const { update_tournaments } = await this.hasura.mutation({
        update_tournaments: {
          __args: {
            where: {
              _and: [
                {
                  start: {
                    _lte: now,
                  },
                },
                {
                  status: {
                    _eq: "RegistrationClosed",
                  },
                },
              ],
            },
            _set: {
              status: "Live",
            },
          },
          affected_rows: true,
        },
      });

      if (update_tournaments.affected_rows > 0) {
        this.logger.log(
          `${update_tournaments.affected_rows} tournaments started`,
        );
      }

      return update_tournaments.affected_rows;
    } catch (error) {
      this.logger.error(`cannot update tournaments`, JSON.stringify(error));
    }
  }
}
