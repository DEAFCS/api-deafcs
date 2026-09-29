import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import {
  CAPTAIN_PICK_FINALIZE_ATTEMPTS,
  CaptainPickFinalizeBusyError,
  CaptainPickService,
} from "../captain-pick/captain-pick.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class CaptainPickFinalize extends WorkerHost {
  constructor(private readonly captainPick: CaptainPickService) {
    super();
  }

  async process(job: Job<{ confirmationId: string }>): Promise<void> {
    const { confirmationId } = job.data;

    try {
      await this.captainPick.finalize(confirmationId);
    } catch (error) {
      const attempts = job.opts.attempts ?? CAPTAIN_PICK_FINALIZE_ATTEMPTS;
      const lastAttempt = job.attemptsMade + 1 >= attempts;

      // Busy means another runner owns match creation right now; it is not a
      // reason to give up on the draft.
      if (lastAttempt && !(error instanceof CaptainPickFinalizeBusyError)) {
        await this.captainPick.failFinalize(confirmationId, error);
        return;
      }

      throw error;
    }
  }
}
