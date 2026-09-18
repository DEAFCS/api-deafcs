import { Global, Module } from "@nestjs/common";
import { PostgresModule } from "src/postgres/postgres.module";
import { BlocksService } from "./blocks.service";

// Global, same reasoning as SanctionsModule: ChatModule and
// DraftGamesModule both need this, and it has no dependents of its own
// that would create a require cycle.
@Global()
@Module({
  imports: [PostgresModule],
  providers: [BlocksService],
  exports: [BlocksService],
})
export class BlocksModule {}
