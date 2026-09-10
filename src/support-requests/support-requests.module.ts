import { Module } from "@nestjs/common";
import { SupportRequestsController } from "./support-requests.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PostgresModule } from "../postgres/postgres.module";

@Module({
  imports: [HasuraModule, NotificationsModule, PostgresModule],
  controllers: [SupportRequestsController],
})
export class SupportRequestsModule {}
