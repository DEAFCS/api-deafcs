import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";

// DEAFCS: frees on-demand servers whose ended match's pod is confirmed gone
// (MatchAssistantService.reconcileDrainingOnDemandServers). Separate from the
// Server Reaper, which stays report-only.
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ReconcileDrainingOnDemandServers extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly matchAssistant: MatchAssistantService,
  ) {
    super();
  }

  async process(): Promise<void> {
    try {
      await this.matchAssistant.reconcileDrainingOnDemandServers();
    } catch (error) {
      this.logger.error(
        `ReconcileDrainingOnDemandServers failed: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
    }
  }
}
