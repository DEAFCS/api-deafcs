import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { CaptainPickService } from "../captain-pick/captain-pick.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class CaptainPickTimeout extends WorkerHost {
  constructor(private readonly captainPick: CaptainPickService) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
      pickIndex: number;
      deadline: string;
    }>,
  ): Promise<void> {
    const { confirmationId, pickIndex, deadline } = job.data;

    // A draft that has since ended (match over, cleaned up) has nothing to
    // time out.
    if (!(await this.captainPick.hasDraft(confirmationId))) {
      return;
    }

    await this.captainPick.handleTimeout(confirmationId, pickIndex, deadline);
  }
}
