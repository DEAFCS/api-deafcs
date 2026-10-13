import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatService } from "../chat.service";
import {
  ChatVideoQueues,
  ExpireChatAttachmentJobName,
} from "../enums/ChatVideoQueues";

@UseQueue("ChatVideo", ChatVideoQueues.DraftExpiry)
export class ExpireSentChatVideoMedia extends WorkerHost {
  constructor(private readonly chat: ChatService) {
    super();
  }

  async process(
    job: Job<{ mediaId?: string; attachmentId?: string; objectKey: string }>,
  ): Promise<void> {
    if (job.name === ExpireChatAttachmentJobName) {
      await this.chat.cleanupExpiredChatAttachment(
        job.data.attachmentId as string,
        job.data.objectKey,
      );
      return;
    }
    await this.chat.cleanupExpiredSentVideoMedia(
      job.data.mediaId as string,
      job.data.objectKey,
    );
  }
}
