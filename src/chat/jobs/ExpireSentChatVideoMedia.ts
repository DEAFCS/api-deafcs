import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatService } from "../chat.service";
import { ChatVideoQueues } from "../enums/ChatVideoQueues";

@UseQueue("ChatVideo", ChatVideoQueues.DraftExpiry)
export class ExpireSentChatVideoMedia extends WorkerHost {
  constructor(private readonly chat: ChatService) {
    super();
  }

  async process(
    job: Job<{ mediaId: string; objectKey: string }>,
  ): Promise<void> {
    await this.chat.cleanupExpiredSentVideoMedia(
      job.data.mediaId,
      job.data.objectKey,
    );
  }
}
