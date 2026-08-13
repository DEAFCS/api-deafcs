import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { NotificationsService } from "./notifications.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { NotificationsQueues } from "./enums/NotificationsQueues";
import { SendSanctionNotifications } from "./jobs/SendSanctionNotifications";
import { PushNotificationsService } from "./push/push-notifications.service";
import { PushNotificationsController } from "./push/push-notifications.controller";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    ConfigModule,
    BullModule.registerQueue({
      name: NotificationsQueues.SanctionNotifications,
    }),
    BullBoardModule.forFeature({
      name: NotificationsQueues.SanctionNotifications,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [PushNotificationsController],
  providers: [
    NotificationsService,
    PushNotificationsService,
    SendSanctionNotifications,
    ...getQueuesProcessors("Notifications"),
    loggerFactory(),
  ],
  exports: [NotificationsService, PushNotificationsService],
})
export class NotificationsModule {}
