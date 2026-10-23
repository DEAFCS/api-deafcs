import { randomBytes, randomUUID } from "crypto";
import { pipeline, Readable, Transform } from "stream";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { S3Service } from "../s3/s3.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatVideoQueues } from "./enums/ChatVideoQueues";
import { MAX_ATTACHMENT_BYTES } from "./chat-attachment-upload";

// Ported from 5stackgg/api cecc882 src/chat/chat-attachments.service.ts: the
// create / parts / complete / discard upload flow, its part math and its
// per-player and per-process upload slots.
//
// DEAFCS differences:
// - An upload in progress is a Redis record, not a chat_attachments row. A
//   completed upload is the same chat-attachments/<steam_id>/<hex>.<ext> object
//   the single-request upload made, so sending, viewing and expiring a file
//   are unchanged and every existing attachment keeps working.
// - No room, quota, poster or content sniffing: DEAFCS checks the file when
//   the message is sent (ChatService), as it did before.
// - The minio client takes a part as a whole body, so a part (at most
//   PART_SIZE) is held while it is sent instead of streamed.
// - An upload nobody completes is aborted by the AbortChatAttachmentUpload
//   job rather than by a sweep of rows.

export interface ChatAttachmentUpload {
  name?: unknown;
  size?: unknown;
  mime_type?: unknown;
}

export interface ChatAttachmentUploadRecord {
  steamId: string;
  objectKey: string;
  uploadId: string;
  size: number;
  mimeType: string;
}

export const AbortChatAttachmentUploadJobName = "AbortChatAttachmentUpload";

@Injectable()
export class ChatAttachmentsService {
  // Each part is its own request through Cloudflare, which refuses a body over
  // 100 MB. S3 refuses a part under 5 MiB unless it is the last.
  public static readonly PART_SIZE = 8 * 1024 * 1024;

  public static readonly MAX_FILE_BYTES = MAX_ATTACHMENT_BYTES;

  public static readonly PENDING_TTL_MS = 24 * 60 * 60 * 1000;

  // Per api pod: each part in flight holds a socket and a request to storage.
  public static readonly MAX_UPLOADS_PER_PLAYER = 2;

  public static readonly MAX_UPLOADS_PER_PROCESS = 16;

  public static readonly PREFIX = "chat-attachments";

  public static readonly EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };

  private readonly redis: Redis;

  private uploadsInFlight = 0;

  private readonly uploadsByPlayer = new Map<string, number>();

  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    redisManager: RedisManagerService,
    @Optional()
    @InjectQueue(ChatVideoQueues.DraftExpiry)
    private readonly queue?: Queue,
  ) {
    this.redis = redisManager.getConnection();
  }

  public static uploadRefusal(
    upload: ChatAttachmentUpload,
    maxBytes: number,
  ): ChatErrorCode | null {
    if (
      typeof upload.mime_type !== "string" ||
      !ChatAttachmentsService.EXTENSIONS[upload.mime_type]
    ) {
      return ChatErrorCode.UnsupportedType;
    }

    if (
      typeof upload.size !== "number" ||
      !Number.isSafeInteger(upload.size) ||
      upload.size <= 0
    ) {
      return ChatErrorCode.Invalid;
    }

    if (upload.size > maxBytes) {
      return ChatErrorCode.TooLarge;
    }

    return null;
  }

  public static partCount(size: number): number {
    return Math.ceil(size / ChatAttachmentsService.PART_SIZE);
  }

  public static partLength(size: number, part: number): number | null {
    const parts = ChatAttachmentsService.partCount(size);

    if (!Number.isInteger(part) || part < 1 || part > parts) {
      return null;
    }

    if (part < parts) {
      return ChatAttachmentsService.PART_SIZE;
    }

    return size - (parts - 1) * ChatAttachmentsService.PART_SIZE;
  }

  private static uploadKey(id: string) {
    return `chat_attachment_upload:${id}`;
  }

  private static jobId(id: string) {
    return `chat-attachment-upload-${id}`;
  }

  // The abort job goes in with the upload, so there is never an upload in
  // storage without something that will clean it up.
  public async create(
    steamId: string,
    upload: ChatAttachmentUpload,
  ): Promise<
    { id: string; part_size: number; parts: number } | { code: ChatErrorCode }
  > {
    const refusal = ChatAttachmentsService.uploadRefusal(
      upload,
      ChatAttachmentsService.MAX_FILE_BYTES,
    );

    if (refusal) {
      return { code: refusal };
    }

    const size = upload.size as number;
    const mimeType = upload.mime_type as string;
    const id = randomUUID();
    const objectKey = `${ChatAttachmentsService.PREFIX}/${steamId}/${randomBytes(8).toString("hex")}.${ChatAttachmentsService.EXTENSIONS[mimeType]}`;

    const uploadId = await this.s3.createMultipartUpload(objectKey);

    const record: ChatAttachmentUploadRecord = {
      steamId,
      objectKey,
      uploadId,
      size,
      mimeType,
    };

    try {
      await this.redis.set(
        ChatAttachmentsService.uploadKey(id),
        JSON.stringify(record),
        "PX",
        ChatAttachmentsService.PENDING_TTL_MS + 60 * 60 * 1000,
      );
      await this.queue?.add(
        AbortChatAttachmentUploadJobName,
        { id, objectKey, uploadId },
        {
          jobId: ChatAttachmentsService.jobId(id),
          delay: ChatAttachmentsService.PENDING_TTL_MS,
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );
    } catch (error) {
      await this.redis.del(ChatAttachmentsService.uploadKey(id)).catch(() => 0);
      await this.s3
        .abortMultipartUpload(objectKey, uploadId)
        .catch(() => {});
      throw error;
    }

    return {
      id,
      part_size: ChatAttachmentsService.PART_SIZE,
      parts: ChatAttachmentsService.partCount(size),
    };
  }

  private async uploading(
    steamId: string,
    id: string,
  ): Promise<ChatAttachmentUploadRecord | undefined> {
    const raw = await this.redis.get(ChatAttachmentsService.uploadKey(id));

    if (!raw) {
      return undefined;
    }

    try {
      const record = JSON.parse(raw) as ChatAttachmentUploadRecord;

      return record.steamId === steamId ? record : undefined;
    } catch {
      return undefined;
    }
  }

  // Exactly one of complete, discard and the abort job gets to finish an
  // upload: whichever removes its record.
  private async take(
    steamId: string,
    id: string,
  ): Promise<ChatAttachmentUploadRecord | undefined> {
    const record = await this.uploading(steamId, id);

    if (!record) {
      return undefined;
    }

    if ((await this.redis.del(ChatAttachmentsService.uploadKey(id))) !== 1) {
      return undefined;
    }

    await this.queue
      ?.remove(ChatAttachmentsService.jobId(id))
      .catch(() => {});

    return record;
  }

  private acquireUploadSlot(steamId: string): (() => void) | null {
    const mine = this.uploadsByPlayer.get(steamId) ?? 0;

    if (
      mine >= ChatAttachmentsService.MAX_UPLOADS_PER_PLAYER ||
      this.uploadsInFlight >= ChatAttachmentsService.MAX_UPLOADS_PER_PROCESS
    ) {
      return null;
    }

    this.uploadsByPlayer.set(steamId, mine + 1);
    this.uploadsInFlight++;

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.uploadsInFlight--;

      const left = (this.uploadsByPlayer.get(steamId) ?? 1) - 1;

      if (left > 0) {
        this.uploadsByPlayer.set(steamId, left);
        return;
      }

      this.uploadsByPlayer.delete(steamId);
    };
  }

  // Through pipeline, so an error on either side is handled here: a sender
  // that drops mid-part would otherwise re-emit an 'error' nothing listens
  // for, which takes the process down.
  private static exactly(
    source: Readable,
    length: number,
  ): { stream: Readable; failed: () => boolean } {
    let seen = 0;
    let failed = false;

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;

        if (seen > length) {
          callback(new Error("part is longer than it said"));
          return;
        }

        callback(null, chunk);
      },
      flush(callback) {
        if (seen !== length) {
          callback(new Error("part is shorter than it said"));
          return;
        }

        callback();
      },
    });

    pipeline(source, counter, (error) => {
      if (error) {
        failed = true;
      }
    });

    return {
      stream: counter,
      failed: () => failed,
    };
  }

  // The upload is authorized before a byte of the body is read, and the part
  // is held to the length it must have.
  public async uploadPart(
    steamId: string,
    id: string,
    part: number,
    body: Readable | Buffer,
    declaredLength?: number,
  ): Promise<ChatErrorCode | null> {
    const stream = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    const length =
      declaredLength ?? (Buffer.isBuffer(body) ? body.length : Number.NaN);

    const release = this.acquireUploadSlot(steamId);

    if (!release) {
      return ChatErrorCode.RateLimited;
    }

    try {
      const record = await this.uploading(steamId, id);

      if (!record) {
        return ChatErrorCode.NotFound;
      }

      const expected = ChatAttachmentsService.partLength(record.size, part);

      if (expected === null || length !== expected) {
        return ChatErrorCode.Invalid;
      }

      const checked = ChatAttachmentsService.exactly(stream, expected);
      const chunks: Buffer[] = [];

      try {
        for await (const chunk of checked.stream) {
          chunks.push(chunk as Buffer);
        }
      } catch {
        return ChatErrorCode.Invalid;
      }

      if (checked.failed()) {
        return ChatErrorCode.Invalid;
      }

      try {
        await this.s3.uploadPart(
          record.objectKey,
          record.uploadId,
          part,
          Buffer.concat(chunks),
        );
      } catch (error) {
        this.logger.warn(
          `unable to store part ${part} of chat attachment ${id}`,
          error,
        );
        return ChatErrorCode.Unavailable;
      }

      return null;
    } finally {
      release();
    }
  }

  // Answers with what the single-request upload answered, so the message
  // send that follows is the same either way.
  public async complete(
    steamId: string,
    id: string,
  ): Promise<
    | { success: true; path: string; contentType: string }
    | { code: ChatErrorCode }
  > {
    const record = await this.take(steamId, id);

    if (!record) {
      return { code: ChatErrorCode.NotFound };
    }

    try {
      await this.s3.completeMultipartUpload(record.objectKey, record.uploadId);
    } catch (error) {
      this.logger.warn(`unable to complete chat attachment ${id}`, error);
      await this.s3
        .abortMultipartUpload(record.objectKey, record.uploadId)
        .catch(() => {});
      return { code: ChatErrorCode.Invalid };
    }

    const stored = await this.s3.stat(record.objectKey);

    if (stored.size !== record.size) {
      await this.s3.remove(record.objectKey);
      return { code: ChatErrorCode.Invalid };
    }

    return {
      success: true,
      path: record.objectKey,
      contentType: record.mimeType,
    };
  }

  // Taken out of the composer, or given up on, before it was ever sent.
  public async discard(steamId: string, id: string): Promise<boolean> {
    const record = await this.take(steamId, id);

    if (!record) {
      return false;
    }

    await this.s3
      .abortMultipartUpload(record.objectKey, record.uploadId)
      .catch((error) =>
        this.logger.warn(`unable to abort chat attachment ${id}`, error),
      );

    return true;
  }

  // An upload nobody completed or discarded. A retry of the job aborts again
  // even though the record is gone: storage says when there is nothing left.
  public async expireUpload(
    id: string,
    objectKey: string,
    uploadId: string,
    retry: boolean,
  ): Promise<void> {
    const pending =
      (await this.redis.del(ChatAttachmentsService.uploadKey(id))) === 1;

    if (!pending && !retry) {
      return;
    }

    try {
      await this.s3.abortMultipartUpload(objectKey, uploadId);
    } catch (error) {
      if ((error as { code?: string })?.code === "NoSuchUpload") {
        return;
      }
      throw error;
    }
  }
}
