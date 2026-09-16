import { Module } from "@nestjs/common";
import { AdminCallController } from "./admin-call.controller";
import { AdminCallService } from "./admin-call.service";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, PostgresModule, RedisModule],
  controllers: [AdminCallController],
  providers: [AdminCallService, loggerFactory()],
})
export class AdminCallsModule {}
