import { Module } from "@nestjs/common";
import { PostgresModule } from "src/postgres/postgres.module";
import { TermsService } from "./terms.service";

@Module({
  imports: [PostgresModule],
  providers: [TermsService],
  exports: [TermsService],
})
export class TermsModule {}
