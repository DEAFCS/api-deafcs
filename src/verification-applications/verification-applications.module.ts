import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { VerificationApplicationsController } from "./verification-applications.controller";
import { VerificationCallController } from "./verification-call.controller";
import { VerificationCallService } from "./verification-call.service";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { VerificationCallQueues } from "./enums/VerificationCallQueues";
import { TimeoutVerificationCallRing } from "./jobs/TimeoutVerificationCallRing";
import { getQueuesProcessors } from "../utilities/QueueProcessors";

@Module({
  imports: [
    HasuraModule,
    NotificationsModule,
    PostgresModule,
    RedisModule,
    BullModule.registerQueue({ name: VerificationCallQueues.RingTimeout }),
    BullBoardModule.forFeature({
      name: VerificationCallQueues.RingTimeout,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [VerificationApplicationsController, VerificationCallController],
  providers: [
    VerificationCallService,
    TimeoutVerificationCallRing,
    ...getQueuesProcessors("VerificationCalls"),
    loggerFactory(),
  ],
})
export class VerificationApplicationsModule {}
