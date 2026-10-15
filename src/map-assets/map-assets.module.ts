import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PostgresModule } from "../postgres/postgres.module";
import { K8sModule } from "../k8s/k8s.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MapAssetsQueues } from "./enums/MapAssetsQueues";
import { UtilityQueues } from "../utility/enums/UtilityQueues";
import { MapAssetsService } from "./map-assets.service";

// DEAFCS: upstream's module also registers the BuildMapAssets worker (and its
// Bull Board entry), which builds and publishes map assets to 5Stack's B2
// bucket. MapAssetsService only builds on the 5stack.gg install
// (WEB_DOMAIN === "5stack.gg"), so DEAFCS reads 5Stack's published assets and
// leaves the worker, its notification and the map_asset_builds table out. The
// queue is still registered because MapAssetsService injects it.
@Module({
  imports: [
    PostgresModule,
    K8sModule,
    BullModule.registerQueue(
      {
        name: MapAssetsQueues.BuildMapAssets,
      },
      {
        name: UtilityQueues.UtilityMeta,
      },
    ),
  ],
  providers: [MapAssetsService, loggerFactory()],
  exports: [MapAssetsService],
})
export class MapAssetsModule {}
