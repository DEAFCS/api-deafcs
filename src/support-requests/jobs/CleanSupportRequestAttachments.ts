import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { SupportRequestQueues } from "../enums/SupportRequestQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { S3Service } from "../../s3/s3.service";

const RETENTION_DAYS = 7;

// Runs hourly (see SupportRequestsModule) and deletes any support
// request/reply attachment older than RETENTION_DAYS, in both the S3
// object store and the DB reference -- attachment_url is cleared but
// attachment_removed_at is set (not just deleted outright) so the
// thread can keep showing "attachment removed" instead of the
// reference just silently vanishing.
@UseQueue("SupportRequests", SupportRequestQueues.AttachmentCleanup)
export class CleanSupportRequestAttachments extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {
    super();
  }

  async process(): Promise<number> {
    const requests = await this.postgres.query<
      Array<{ id: string; attachment_url: string }>
    >(
      `SELECT id, attachment_url
         FROM public.support_requests
        WHERE attachment_url IS NOT NULL
          AND attachment_removed_at IS NULL
          AND created_at < now() - interval '${RETENTION_DAYS} days'`,
    );

    for (const row of requests) {
      await this.s3.remove(row.attachment_url);
      await this.postgres.query(
        `UPDATE public.support_requests
            SET attachment_url = NULL, attachment_removed_at = now()
          WHERE id = $1`,
        [row.id],
      );
    }

    const messages = await this.postgres.query<
      Array<{ id: string; attachment_url: string }>
    >(
      `SELECT id, attachment_url
         FROM public.support_request_messages
        WHERE attachment_url IS NOT NULL
          AND attachment_removed_at IS NULL
          AND created_at < now() - interval '${RETENTION_DAYS} days'`,
    );

    for (const row of messages) {
      await this.s3.remove(row.attachment_url);
      await this.postgres.query(
        `UPDATE public.support_request_messages
            SET attachment_url = NULL, attachment_removed_at = now()
          WHERE id = $1`,
        [row.id],
      );
    }

    const total = requests.length + messages.length;
    if (total > 0) {
      this.logger.log(
        `Removed ${total} support request attachment(s) older than ${RETENTION_DAYS} days`,
      );
    }
    return total;
  }
}
