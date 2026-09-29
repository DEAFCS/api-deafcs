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

  async process(
    job: Job<{ confirmationId: string; recovery?: boolean }>,
  ): Promise<void> {
    const { confirmationId, recovery } = job.data;

    // A follow-up after the normal attempts ran out: only resolve (recover,
    // clean up or release), never start creating from scratch again.
    if (recovery) {
      await this.captainPick.handleFinalizeExhausted(
        confirmationId,
        "match creation recovery",
      );
      return;
    }

    try {
      await this.captainPick.finalize(confirmationId);
    } catch (error) {
      const attempts = job.opts.attempts ?? CAPTAIN_PICK_FINALIZE_ATTEMPTS;
      const lastAttempt = job.attemptsMade + 1 >= attempts;

      if (lastAttempt) {
        // Busy means another runner owns match creation right now; resolving
        // is still attempted, and itself waits its turn via the same lock.
        await this.captainPick.handleFinalizeExhausted(
          confirmationId,
          error instanceof CaptainPickFinalizeBusyError ? "busy" : error,
        );
        return;
      }

      throw error;
    }
  }
}
