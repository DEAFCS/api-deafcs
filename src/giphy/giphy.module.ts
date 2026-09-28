import { Module } from "@nestjs/common";
import { CacheModule } from "../cache/cache.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { GiphyService } from "./giphy.service";

@Module({
  imports: [CacheModule],
  providers: [GiphyService, loggerFactory()],
  exports: [GiphyService],
})
export class GiphyModule {}
