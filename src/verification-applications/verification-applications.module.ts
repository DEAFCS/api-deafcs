import { Module } from "@nestjs/common";
import { VerificationApplicationsController } from "./verification-applications.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";

@Module({
  imports: [HasuraModule, NotificationsModule, PostgresModule],
  controllers: [VerificationApplicationsController],
})
export class VerificationApplicationsModule {}
