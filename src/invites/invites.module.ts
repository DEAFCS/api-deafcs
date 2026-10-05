import { NotificationsModule } from "src/notifications/notifications.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { Module } from "@nestjs/common";
import { InvitesController } from "./invites.controller";
import { HasuraModule } from "src/hasura/hasura.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { TermsModule } from "src/terms/terms.module";

@Module({
  imports: [HasuraModule, TermsModule, PostgresModule, NotificationsModule],
  providers: [loggerFactory()],
  controllers: [InvitesController],
})
export class InvitesModule {}
