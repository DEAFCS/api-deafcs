import { Module } from "@nestjs/common";
import { AwardsService } from "./awards.service";
import { AwardsController } from "./awards.controller";
import { TrophiesLegacyController } from "./trophies-legacy.controller";
import { PlayerOfTheMonthService } from "./player-of-the-month/player-of-the-month.service";
import { PlayerOfTheMonthController } from "./player-of-the-month/player-of-the-month.controller";
import { S3Module } from "../s3/s3.module";
import { PostgresModule } from "../postgres/postgres.module";
import { SystemModule } from "../system/system.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, PostgresModule, SystemModule],
  providers: [AwardsService, PlayerOfTheMonthService, loggerFactory()],
  controllers: [AwardsController, TrophiesLegacyController, PlayerOfTheMonthController],
  exports: [AwardsService],
})
export class AwardsModule {}
