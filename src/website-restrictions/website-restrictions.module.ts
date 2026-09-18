import { Global, Module } from "@nestjs/common";
import { PostgresModule } from "src/postgres/postgres.module";
import { WebsiteRestrictionsService } from "./website-restrictions.service";

@Global()
@Module({
  imports: [PostgresModule],
  providers: [WebsiteRestrictionsService],
  exports: [WebsiteRestrictionsService],
})
export class WebsiteRestrictionsModule {}
