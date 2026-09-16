import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { FaceitQueues } from "../enums/FaceitQueues";
import { FaceitMatchImportService } from "../faceit-match-import.service";
import { FaceitService } from "../faceit.service";

@UseQueue("Faceit", FaceitQueues.PollAllFaceitMatchHistory)
export class PollAllFaceitMatchHistory extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly faceit: FaceitService,
    private readonly faceitImport: FaceitMatchImportService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    try {
      const result = await this.faceit.refreshVerifiedPlayers();
      this.logger.log(
        `faceit leaderboard refresh eligible=${result.eligible} refreshed=${result.refreshed} skipped=${result.skipped} failed=${result.failed}`,
      );
    } catch (error) {
      this.logger.warn(
        `faceit leaderboard refresh failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    await this.faceitImport.pollAllActive();
  }
}
