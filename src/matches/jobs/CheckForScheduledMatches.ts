import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CheckForScheduledMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const now = new Date();
    const fifteenMinutesAhead = new Date();
    fifteenMinutesAhead.setMinutes(fifteenMinutesAhead.getMinutes() + 15);
    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            _and: [
              {
                scheduled_at: {
                  _is_null: false,
                },
              },
              {
                scheduled_at: {
                  _lte: fifteenMinutesAhead,
                },
              },
              {
                status: {
                  _eq: "Scheduled",
                },
              },
              // A tournament match materialized before its tournament's own
              // scheduled start stays 'Scheduled' until the tournament
              // actually begins -- tbu_matches enforces that regardless, so
              // selecting one here would only produce a no-op UPDATE (and a
              // misleading "N matches started" log) on every pass. Mirrors
              // tournament_match_is_pre_start()'s condition exactly.
              {
                _not: {
                  tournament_brackets: {
                    stage: {
                      tournament: {
                        _and: [
                          {
                            status: {
                              _eq: "RegistrationClosed",
                            },
                          },
                          {
                            start: {
                              _gt: now,
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
          _set: {
            status: "WaitingForCheckIn",
          },
        },
        affected_rows: true,
      },
    });

    if (update_matches.affected_rows > 0) {
      this.logger.log(`${update_matches.affected_rows} matches started`);
    }

    return update_matches.affected_rows;
  }
}
