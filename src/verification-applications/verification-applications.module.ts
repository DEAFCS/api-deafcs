import { Module } from "@nestjs/common";
import { VerificationApplicationsController } from "./verification-applications.controller";
import { VerificationCallController } from "./verification-call.controller";
import { VerificationCallService } from "./verification-call.service";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, NotificationsModule, PostgresModule, RedisModule],
  controllers: [VerificationApplicationsController, VerificationCallController],
  providers: [VerificationCallService, loggerFactory()],
})
export class VerificationApplicationsModule {}
