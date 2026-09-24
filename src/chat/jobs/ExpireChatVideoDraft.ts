import { Job } from "bullmq";
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
    await this.chat.cleanupExpiredVideoDraft(job.data.sessionId);
  }
}
