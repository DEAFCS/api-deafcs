import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { TwitchService } from "./twitch.service";
import { TwitchStreamsService } from "./twitch-streams.service";
import { TwitchController } from "./twitch.controller";

@Module({
  imports: [CacheModule, PostgresModule],
  controllers: [TwitchController],
  providers: [TwitchService, TwitchStreamsService, loggerFactory()],
  exports: [TwitchService],
})
export class TwitchModule {}
