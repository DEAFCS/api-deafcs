import { DelayedError, Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatService } from "../chat.service";
import { ChatVideoQueues } from "../enums/ChatVideoQueues";

@UseQueue("ChatVideo", ChatVideoQueues.DraftExpiry)
export class ExpireChatVideoDraft extends WorkerHost {
  constructor(private readonly chat: ChatService) {
    super();
  }

  async process(job: Job<{ sessionId: string }>): Promise<void> {
    const delay = await this.chat.cleanupExpiredVideoDraft(job.data.sessionId);
    if (delay) {
      await job.moveToDelayed(Date.now() + delay, job.token);
      throw new DelayedError();
    }
  }
}
