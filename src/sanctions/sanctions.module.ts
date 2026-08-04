import {
  Global,
  Module,
  MiddlewareConsumer,
  RequestMethod,
  NestModule,
} from "@nestjs/common";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { RconModule } from "src/rcon/rcon.module";
import { DedicatedServersModule } from "src/dedicated-servers/dedicated-servers.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { MatchServerMiddlewareMiddleware } from "src/matches/match-server-middleware/match-server-middleware.middleware";
import { SanctionsService } from "./sanctions.service";
import { SanctionsController } from "./sanctions.controller";

// Global: DisconnectBudgetService (in MatchesModule) needs SanctionsService,
// but MatchesModule already sits in a require cycle with RconModule (see the
// forwardRef(() => RconModule) below), and this module's own top-level
// `import { RconModule }` means importing SanctionsModule from MatchesModule
// pulls that cycle in again and leaves RconModule undefined at boot
// (UndefinedModuleException). Going @Global() lets SanctionsService resolve
// without adding a new module-to-module edge into that cycle.
@Global()
@Module({
  imports: [HasuraModule, PostgresModule, RconModule, DedicatedServersModule],
  providers: [SanctionsService, loggerFactory()],
  controllers: [SanctionsController],
  exports: [SanctionsService],
})
export class SanctionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MatchServerMiddlewareMiddleware).forRoutes({
      path: "sanctions/server/:serverId",
      method: RequestMethod.GET,
    });
  }
}
