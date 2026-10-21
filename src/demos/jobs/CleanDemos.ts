import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DemoQueues } from "../enums/DemoQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DemoMetadataService } from "../demo-metadata.service";

@UseQueue("Demos", DemoQueues.Demos)
export class CleanDemos extends WorkerHost {
  private static readonly PAGE_SIZE = 10;

  private maxStorageInBytes: number;
  private minRetentionInDays: number;
  private totalStoredBytes: number;

  constructor(
    private readonly demoMetadata: DemoMetadataService,
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            _or: [
              {
                name: {
                  _eq: "s3_min_retention",
                },
              },
              {
                name: {
                  _eq: "s3_max_storage",
                },
              },
            ],
          },
        },
        name: true,
        value: true,
      },
    });

    this.minRetentionInDays = parseInt(
      settings.find(function (setting) {
        return setting.name === "s3_min_retention";
      })?.value || "1",
    );

    const maxStorageInGB = parseInt(
      settings.find(function (setting) {
        return setting.name === "s3_max_storage";
      })?.value || "10",
    );

    this.maxStorageInBytes = maxStorageInGB * 1024 * 1024 * 1024;

    const { match_map_demos_aggregate } = await this.hasura.query({
      match_map_demos_aggregate: {
        aggregate: {
          sum: {
            size: true,
            playback_size: true,
          },
        },
      },
    });

    this.totalStoredBytes =
      (match_map_demos_aggregate.aggregate.sum.size ?? 0) +
      (match_map_demos_aggregate.aggregate.sum.playback_size ?? 0);

    return await this.deleteOldDemos();
  }

  private async deleteOldDemos() {
    // DEAFCS: storage at the limit is within it (upstream: `<`).
    if (this.totalStoredBytes <= this.maxStorageInBytes) {
      return 0;
    }

    const demosToDelete = await this.findDemosToDelete();

    if (demosToDelete.length > 0) {
      this.logger.log(
        `Marked ${demosToDelete.length} demos for deletion, freeing up ${this.formatStorageSize(demosToDelete.reduce((total, demo) => total + (demo.size ?? 0) + (demo.playback_size ?? 0), 0))}`,
      );
      for (const demo of demosToDelete) {
        await this.demoMetadata.deleteDemo(demo.id);
        break;
      }
    }

    return demosToDelete.length;
  }

  private async findDemosToDelete(): Promise<
    Array<{
      id: string;
      size: number;
      playback_size: number | null;
      file: string;
    }>
  > {
    const finishedAfter = new Date(
      Date.now() - this.minRetentionInDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    // DEAFCS: upstream re-queried the same first page on every recursion (no
    // offset, nothing is deleted while the list is built) and stopped after
    // the first demo of each page, so a small oldest demo meant tens of
    // thousands of queries and copies of one demo. Page through instead, in a
    // stable order (ended_at ties broken by id), until enough is freed or no
    // demo past retention is left.
    const demosToDelete = [];
    let offset = 0;

    while (this.totalStoredBytes > this.maxStorageInBytes) {
      const { match_map_demos } = await this.hasura.query({
        match_map_demos: {
          __args: {
            limit: CleanDemos.PAGE_SIZE,
            offset,
            where: {
              match: {
                ended_at: {
                  _lt: finishedAfter,
                },
              },
            },
            order_by: [
              {
                match: {
                  ended_at: "asc",
                },
              },
              {
                id: "asc",
              },
            ],
          },
          id: true,
          size: true,
          playback_size: true,
          file: true,
        },
      });

      for (const demo of match_map_demos) {
        if (this.totalStoredBytes <= this.maxStorageInBytes) {
          break;
        }

        demosToDelete.push(demo);
        this.totalStoredBytes -= (demo.size ?? 0) + (demo.playback_size ?? 0);
      }

      if (match_map_demos.length < CleanDemos.PAGE_SIZE) {
        break;
      }

      offset += match_map_demos.length;
    }

    return demosToDelete;
  }

  private formatStorageSize(bytes: number): string {
    const megabytes = bytes / (1024 * 1024);
    const gigabytes = megabytes / 1024;

    if (gigabytes >= 1) {
      return `${gigabytes.toFixed(2)} GB`;
    }
    return `${megabytes.toFixed(2)} MB`;
  }
}
