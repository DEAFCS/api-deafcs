import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { UtilityQueues } from "./enums/UtilityQueues";
import { UtilityCalloutsService } from "./utility-callouts.service";
import { SyncMapCallouts } from "./jobs/SyncMapCallouts";

// DEAFCS: upstream's UtilityModule is the whole nade lineups / practice /
// renders feature. DEAFCS ports only the map callouts part of it (the replay
// viewer's callouts overlay): UtilityCalloutsService and the SyncMapCallouts
// job on the utility-meta queue, wired the way upstream wires them.
@Module({
  imports: [
    PostgresModule,
    BullModule.registerQueue({
      name: UtilityQueues.UtilityMeta,
    }),
    BullBoardModule.forFeature({
      name: UtilityQueues.UtilityMeta,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    UtilityCalloutsService,
    SyncMapCallouts,
    ...getQueuesProcessors("Utility"),
    loggerFactory(),
  ],
  exports: [UtilityCalloutsService],
})
export class UtilityModule {}
