import { Module } from "@nestjs/common";
import { InvitesController } from "./invites.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { TermsModule } from "src/terms/terms.module";

@Module({
  imports: [HasuraModule, TermsModule],
  providers: [loggerFactory()],
  controllers: [InvitesController],
})
export class InvitesModule {}
