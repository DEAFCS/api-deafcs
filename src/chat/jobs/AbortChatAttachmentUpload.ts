import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatAttachmentsService } from "../chat-attachments.service";
import { ChatVideoQueues } from "../enums/ChatVideoQueues";

// Aborts a chat attachment upload that was never completed or discarded, so
// its parts do not stay in storage. Same queue and worker as the other chat
// media cleanups.
@UseQueue("ChatVideo", ChatVideoQueues.DraftExpiry)
export class AbortChatAttachmentUpload extends WorkerHost {
  constructor(private readonly attachments: ChatAttachmentsService) {
    super();
  }

  async process(
    job: Job<{ id: string; objectKey: string; uploadId: string }>,
  ): Promise<void> {
    await this.attachments.expireUpload(
      job.data.id,
      job.data.objectKey,
      job.data.uploadId,
      job.attemptsMade > 0,
    );
  }
}
