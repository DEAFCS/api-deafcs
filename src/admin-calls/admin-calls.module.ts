import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { AdminCallController } from "./admin-call.controller";
import { AdminCallService } from "./admin-call.service";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { AdminCallQueues } from "./enums/AdminCallQueues";
import { TimeoutAdminCallRing } from "./jobs/TimeoutAdminCallRing";
import { getQueuesProcessors } from "../utilities/QueueProcessors";

@Module({
  imports: [
    HasuraModule,
    NotificationsModule,
    PostgresModule,
    RedisModule,
    BullModule.registerQueue({ name: AdminCallQueues.RingTimeout }),
    BullBoardModule.forFeature({
      name: AdminCallQueues.RingTimeout,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [AdminCallController],
  providers: [
    AdminCallService,
    TimeoutAdminCallRing,
    ...getQueuesProcessors("AdminCalls"),
    loggerFactory(),
  ],
})
export class AdminCallsModule {}
