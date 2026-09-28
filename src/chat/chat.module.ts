import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  forwardRef,
} from "@nestjs/common";
import { raw } from "express";
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

@Module({
  imports: [
    HasuraModule,
    RedisModule,
    PostgresModule,
    forwardRef(() => RconModule),
    NotificationsModule,
    S3Module,
  ],
  providers: [ChatService, ChatGateway, loggerFactory()],
  exports: [ChatService],
  controllers: [ChatController],
})
export class ChatModule implements NestModule {
  // The attachment upload route takes the file as a raw binary body (see
  // ChatController.uploadAttachment) rather than JSON or multipart/form-data,
  // so it needs its own body parser instead of the app-wide json/urlencoded
  // ones from main.ts -- those only apply to their own content types and
  // leave this route's stream untouched. `type: () => true` matches
  // regardless of the client's Content-Type (already re-validated against
  // the image/video allow-list in the controller itself).
  public configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(raw({ type: () => true, limit: "210mb" }))
      .forRoutes({ path: "chat/attachment", method: RequestMethod.POST });
  }
}
