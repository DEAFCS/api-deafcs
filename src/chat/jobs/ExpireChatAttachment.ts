import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatService } from "../chat.service";
import { ChatVideoQueues } from "../enums/ChatVideoQueues";

// Removes the stored file of an attachment sent in Organizer or Team Chat
// once its message has expired. Jobs are dispatched by name to the class of
// that name, so this class must stay named ExpireChatAttachmentJobName.
@UseQueue("ChatVideo", ChatVideoQueues.DraftExpiry)
export class ExpireChatAttachment extends WorkerHost {
  constructor(private readonly chat: ChatService) {
    super();
  }

  async process(
    job: Job<{ attachmentId: string; objectKey: string }>,
  ): Promise<void> {
    await this.chat.cleanupExpiredChatAttachment(
      job.data.attachmentId,
      job.data.objectKey,
    );
  }
}
