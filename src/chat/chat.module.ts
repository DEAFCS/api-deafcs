import { Module, forwardRef } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatGateway } from "./chat.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RconModule } from "src/rcon/rcon.module";
import { RedisModule } from "src/redis/redis.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { ChatController } from "./chat.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { S3Module } from "../s3/s3.module";
import { ChatVideoController } from "./chat-video.controller";
import { BullModule } from "@nestjs/bullmq";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { ChatVideoQueues } from "./enums/ChatVideoQueues";
import { ExpireChatVideoDraft } from "./jobs/ExpireChatVideoDraft";
import { ExpireSentChatVideoMedia } from "./jobs/ExpireSentChatVideoMedia";
import { getQueuesProcessors } from "../utilities/QueueProcessors";

@Module({
  imports: [
    HasuraModule,
    RedisModule,
    PostgresModule,
    forwardRef(() => RconModule),
    NotificationsModule,
    S3Module,
    BullModule.registerQueue({ name: ChatVideoQueues.DraftExpiry }),
    BullBoardModule.forFeature({
      name: ChatVideoQueues.DraftExpiry,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    ChatService,
    ChatGateway,
    ExpireChatVideoDraft,
    ExpireSentChatVideoMedia,
    ...getQueuesProcessors("ChatVideo"),
    loggerFactory(),
  ],
  exports: [ChatService],
  controllers: [ChatController, ChatVideoController],
})
export class ChatModule {}
