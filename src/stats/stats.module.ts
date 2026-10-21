import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { StatsController } from "./stats.controller";
import { WeeklyRecordsService } from "./weekly-records.service";

@Module({
  imports: [CacheModule, PostgresModule],
  controllers: [StatsController],
  providers: [WeeklyRecordsService, loggerFactory()],
})
export class StatsModule {}
