import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { CaptainPickService } from "../captain-pick/captain-pick.service";
import { CaptainPickLineup } from "../captain-pick/captain-pick-rules";

// Retries carrying a Captain Pick draft's Team Chat into its match after the
// first try (at match creation) failed. Throws until it succeeds; the move is
// a no-op once the draft rooms are empty.
@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class CaptainPickTeamChatCarryOver extends WorkerHost {
  constructor(private readonly captainPick: CaptainPickService) {
    super();
  }

  async process(
    job: Job<{
      confirmationId: string;
      matchId: string;
      lineupIds: Record<CaptainPickLineup, string>;
    }>,
  ): Promise<void> {
    const { confirmationId, matchId, lineupIds } = job.data;
    await this.captainPick.moveTeamChats(confirmationId, matchId, lineupIds);
  }
}
