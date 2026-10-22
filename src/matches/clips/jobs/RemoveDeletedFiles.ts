import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { MatchQueues } from "../../enums/MatchQueues";
import { UseQueue } from "../../../utilities/QueueProcessors";
import { S3Service } from "../../../s3/s3.service";
import { DeletedFiles, removeDeletedFiles } from "../clip-files";

// DEAFCS: retries removing files whose rows are already deleted (see
// ClipsService.removeDeletedFiles). The job is the only record of them, so a
// failure throws for BullMQ to retry, each attempt keeps only what is left,
// and the last one logs every key it gives up on.
@UseQueue("Clips", MatchQueues.Clips)
export class RemoveDeletedFiles extends WorkerHost {
  constructor(
    private readonly s3: S3Service,
    private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<DeletedFiles>): Promise<number> {
    const left = await removeDeletedFiles(this.s3, job.data);
    const remaining = [...left.keys, ...left.prefixes];
    const removed =
      job.data.keys.length + job.data.prefixes.length - remaining.length;

    if (remaining.length === 0) {
      return removed;
    }

    await job.updateData(left);

    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      this.logger.error(
        `[remove-deleted-files] giving up, still stored: ${remaining.join(", ")}`,
      );
    }

    throw new Error(
      `${remaining.length} deleted file(s) still stored, will retry`,
    );
  }
}
