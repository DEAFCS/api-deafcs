import { Module } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { SupportRequestsController } from "./support-requests.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";
import { S3Module } from "../s3/s3.module";
import { BullModule } from "@nestjs/bullmq";
import { SupportRequestQueues } from "./enums/SupportRequestQueues";
import { CleanSupportRequestAttachments } from "./jobs/CleanSupportRequestAttachments";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    HasuraModule,
    NotificationsModule,
    PostgresModule,
    S3Module,
    BullModule.registerQueue({
      name: SupportRequestQueues.AttachmentCleanup,
    }),
  ],
  controllers: [SupportRequestsController],
  providers: [
    CleanSupportRequestAttachments,
    ...getQueuesProcessors("SupportRequests"),
    loggerFactory(),
  ],
})
export class SupportRequestsModule {
  constructor(
    @InjectQueue(SupportRequestQueues.AttachmentCleanup)
    attachmentCleanupQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void attachmentCleanupQueue.add(
      CleanSupportRequestAttachments.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      },
    );
  }
}
