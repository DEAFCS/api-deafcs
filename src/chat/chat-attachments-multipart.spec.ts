import { Readable } from "stream";
import { Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { AbortChatAttachmentUpload } from "./jobs/AbortChatAttachmentUpload";
import {
  AbortChatAttachmentUploadJobName,
  ChatAttachmentsService,
} from "./chat-attachments.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";

// Chat attachments go up in PART_SIZE parts so no single request reaches
// Cloudflare's 100 MB body cap (a 107 MB video failed as one request).

const MB = 1024 * 1024;
const PART = ChatAttachmentsService.PART_SIZE;
const STEAM_ID = "76561190000000001";
const OTHER_STEAM_ID = "76561190000000002";

function setup() {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };

  const parts = new Map<string, Map<number, number>>();
  const objects = new Map<string, number>();
  let uploads = 0;
  const s3 = {
    createMultipartUpload: jest.fn(async () => {
      const id = `upload-${++uploads}`;
      parts.set(id, new Map());
      return id;
    }),
    uploadPart: jest.fn(
      async (_key: string, uploadId: string, part: number, body: Buffer) => {
        parts.get(uploadId)!.set(part, body.length);
      },
    ),
    completeMultipartUpload: jest.fn(async (key: string, uploadId: string) => {
      const uploaded = parts.get(uploadId);
      if (!uploaded || uploaded.size === 0) throw new Error("no parts uploaded");
      objects.set(
        key,
        [...uploaded.values()].reduce((sum, length) => sum + length, 0),
      );
      parts.delete(uploadId);
    }),
    abortMultipartUpload: jest.fn(async (_key: string, uploadId: string) => {
      if (!parts.delete(uploadId)) {
        throw Object.assign(new Error("gone"), { code: "NoSuchUpload" });
      }
    }),
    stat: jest.fn(async (key: string) => ({ size: objects.get(key) })),
    remove: jest.fn(async (key: string) => objects.delete(key)),
  };

  const queue = {
    add: jest.fn(async () => ({})),
    remove: jest.fn(async () => 1),
  };

  const service = new ChatAttachmentsService(
    { warn: jest.fn() } as unknown as Logger,
    s3 as any,
    { getConnection: () => redis } as any,
    queue as any,
  );

  return { service, s3, queue, redis, parts, objects };
}

async function uploadAll(
  service: ChatAttachmentsService,
  id: string,
  size: number,
  steamId = STEAM_ID,
) {
  for (let part = 1; part <= ChatAttachmentsService.partCount(size); part++) {
    const length = ChatAttachmentsService.partLength(size, part)!;
    expect(
      await service.uploadPart(steamId, id, part, Buffer.alloc(length, 1)),
    ).toBeNull();
  }
}

describe("chat attachment multipart upload", () => {
  describe("part math", () => {
    it("keeps every part well under Cloudflare's 100 MB cap", () => {
      expect(PART).toBe(8 * MB);
      expect(PART).toBeLessThan(100 * 1000 * 1000);
    });

    it("splits the reported 107 MB video into 13 parts", () => {
      const size = 107_418_289;
      expect(ChatAttachmentsService.partCount(size)).toBe(13);
      expect(ChatAttachmentsService.partLength(size, 1)).toBe(PART);
      expect(ChatAttachmentsService.partLength(size, 13)).toBe(
        size - 12 * PART,
      );
      expect(ChatAttachmentsService.partLength(size, 14)).toBeNull();
      expect(ChatAttachmentsService.partLength(size, 0)).toBeNull();
      expect(ChatAttachmentsService.partLength(size, 1.5)).toBeNull();
    });
  });

  describe("create", () => {
    it("allows a file of exactly 200 MB", async () => {
      const { service, queue } = setup();
      const created = await service.create(STEAM_ID, {
        size: 200 * MB,
        mime_type: "video/mp4",
      });

      expect(created).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        part_size: PART,
        parts: 25,
      });
      expect(queue.add).toHaveBeenCalledWith(
        AbortChatAttachmentUploadJobName,
        expect.objectContaining({ uploadId: "upload-1" }),
        expect.objectContaining({
          jobId: `chat-attachment-upload-${(created as { id: string }).id}`,
          delay: ChatAttachmentsService.PENDING_TTL_MS,
        }),
      );
    });

    it("refuses a file over 200 MB before anything reaches storage", async () => {
      const { service, s3 } = setup();
      await expect(
        service.create(STEAM_ID, { size: 200 * MB + 1, mime_type: "video/mp4" }),
      ).resolves.toEqual({ code: ChatErrorCode.TooLarge });
      expect(s3.createMultipartUpload).not.toHaveBeenCalled();
    });

    it.each([
      [{ size: 10, mime_type: "application/pdf" }, ChatErrorCode.UnsupportedType],
      [{ size: 10 }, ChatErrorCode.UnsupportedType],
      [{ size: 0, mime_type: "video/mp4" }, ChatErrorCode.Invalid],
      [{ size: "10", mime_type: "video/mp4" }, ChatErrorCode.Invalid],
      [{ size: 1.5, mime_type: "video/mp4" }, ChatErrorCode.Invalid],
    ])("refuses %p", async (upload, code) => {
      const { service } = setup();
      await expect(service.create(STEAM_ID, upload)).resolves.toEqual({ code });
    });

    it("aborts the storage upload when it cannot be recorded", async () => {
      const { service, s3, redis } = setup();
      redis.set.mockRejectedValueOnce(new Error("redis down"));

      await expect(
        service.create(STEAM_ID, { size: 10, mime_type: "image/png" }),
      ).rejects.toThrow("redis down");
      expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        "upload-1",
      );
    });
  });

  describe("upload and complete", () => {
    it("stores a 200 MB video part by part and answers like the single-request upload", async () => {
      const { service, s3, objects, queue } = setup();
      const size = 200 * MB;
      const { id } = (await service.create(STEAM_ID, {
        size,
        mime_type: "video/quicktime",
      })) as { id: string };

      await uploadAll(service, id, size);
      expect(s3.uploadPart).toHaveBeenCalledTimes(25);
      for (const call of s3.uploadPart.mock.calls) {
        expect((call[3] as Buffer).length).toBeLessThanOrEqual(PART);
      }

      const completed = await service.complete(STEAM_ID, id);

      // The key ChatService accepts on send, so the rest of the flow is as before.
      expect(completed).toEqual({
        success: true,
        path: expect.stringMatching(
          new RegExp(`^chat-attachments/${STEAM_ID}/[0-9a-f]{16}\\.mov$`),
        ),
        contentType: "video/quicktime",
      });
      expect(objects.get((completed as { path: string }).path)).toBe(size);
      expect(queue.remove).toHaveBeenCalledWith(`chat-attachment-upload-${id}`);
    });

    it("cannot complete the same upload twice", async () => {
      const { service } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 10,
        mime_type: "image/png",
      })) as { id: string };
      await uploadAll(service, id, 10);

      await expect(service.complete(STEAM_ID, id)).resolves.toMatchObject({
        success: true,
      });
      await expect(service.complete(STEAM_ID, id)).resolves.toEqual({
        code: ChatErrorCode.NotFound,
      });
    });

    it("refuses a part of the wrong length or number", async () => {
      const { service, s3 } = setup();
      const size = PART + 10;
      const { id } = (await service.create(STEAM_ID, {
        size,
        mime_type: "video/mp4",
      })) as { id: string };

      await expect(
        service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(10)),
      ).resolves.toBe(ChatErrorCode.Invalid);
      await expect(
        service.uploadPart(STEAM_ID, id, 3, Buffer.alloc(10)),
      ).resolves.toBe(ChatErrorCode.Invalid);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a body that ends before its declared length", async () => {
      const { service, s3 } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 100,
        mime_type: "image/png",
      })) as { id: string };

      await expect(
        service.uploadPart(
          STEAM_ID,
          id,
          1,
          Readable.from([Buffer.alloc(60)]),
          100,
        ),
      ).resolves.toBe(ChatErrorCode.Invalid);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a body longer than its declared length", async () => {
      const { service, s3 } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 100,
        mime_type: "image/png",
      })) as { id: string };

      await expect(
        service.uploadPart(
          STEAM_ID,
          id,
          1,
          Readable.from([Buffer.alloc(60), Buffer.alloc(60)]),
          100,
        ),
      ).resolves.toBe(ChatErrorCode.Invalid);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("does not let another player touch the upload", async () => {
      const { service, s3 } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 10,
        mime_type: "image/png",
      })) as { id: string };

      await expect(
        service.uploadPart(OTHER_STEAM_ID, id, 1, Buffer.alloc(10)),
      ).resolves.toBe(ChatErrorCode.NotFound);
      await expect(service.complete(OTHER_STEAM_ID, id)).resolves.toEqual({
        code: ChatErrorCode.NotFound,
      });
      await expect(service.discard(OTHER_STEAM_ID, id)).resolves.toBe(false);
      expect(s3.abortMultipartUpload).not.toHaveBeenCalled();

      await uploadAll(service, id, 10);
      await expect(service.complete(STEAM_ID, id)).resolves.toMatchObject({
        success: true,
      });
    });

    it("holds one player to two parts in flight", async () => {
      const { service, s3 } = setup();
      const size = 3 * PART;
      const { id } = (await service.create(STEAM_ID, {
        size,
        mime_type: "video/mp4",
      })) as { id: string };

      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      s3.uploadPart.mockImplementation(() => gate);

      const first = service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(PART));
      const second = service.uploadPart(STEAM_ID, id, 2, Buffer.alloc(PART));
      await expect(
        service.uploadPart(STEAM_ID, id, 3, Buffer.alloc(PART)),
      ).resolves.toBe(ChatErrorCode.RateLimited);

      finish();
      await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
      s3.uploadPart.mockResolvedValue(undefined);
      await expect(
        service.uploadPart(STEAM_ID, id, 3, Buffer.alloc(PART)),
      ).resolves.toBeNull();
    });

    it("answers unavailable when storage refuses a part, and the part can be sent again", async () => {
      const { service, s3 } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 10,
        mime_type: "image/png",
      })) as { id: string };
      s3.uploadPart.mockRejectedValueOnce(new Error("storage down"));

      await expect(
        service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(10)),
      ).resolves.toBe(ChatErrorCode.Unavailable);
      await expect(
        service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(10)),
      ).resolves.toBeNull();
    });

    it("aborts the upload when storage cannot complete it", async () => {
      const { service, s3 } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 2 * PART,
        mime_type: "video/mp4",
      })) as { id: string };
      s3.completeMultipartUpload.mockRejectedValueOnce(new Error("no parts"));

      await expect(service.complete(STEAM_ID, id)).resolves.toEqual({
        code: ChatErrorCode.Invalid,
      });
      expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        "upload-1",
      );
    });

    it("removes the file when what was stored is not what was declared", async () => {
      const { service, s3, objects } = setup();
      const size = 2 * PART;
      const { id } = (await service.create(STEAM_ID, {
        size,
        mime_type: "video/mp4",
      })) as { id: string };
      // Only the first part was ever sent.
      await service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(PART));

      await expect(service.complete(STEAM_ID, id)).resolves.toEqual({
        code: ChatErrorCode.Invalid,
      });
      expect(s3.remove).toHaveBeenCalled();
      expect(objects.size).toBe(0);
    });
  });

  describe("cleanup", () => {
    it("discard aborts the storage upload and ends it", async () => {
      const { service, s3, parts, queue } = setup();
      const { id } = (await service.create(STEAM_ID, {
        size: 2 * PART,
        mime_type: "video/mp4",
      })) as { id: string };
      await service.uploadPart(STEAM_ID, id, 1, Buffer.alloc(PART));

      await expect(service.discard(STEAM_ID, id)).resolves.toBe(true);
      expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        "upload-1",
      );
      expect(parts.size).toBe(0);
      expect(queue.remove).toHaveBeenCalledWith(`chat-attachment-upload-${id}`);
      await expect(
        service.uploadPart(STEAM_ID, id, 2, Buffer.alloc(PART)),
      ).resolves.toBe(ChatErrorCode.NotFound);
      await expect(service.discard(STEAM_ID, id)).resolves.toBe(false);
    });

    it("the abort job aborts an upload nobody finished", async () => {
      const { service, s3, queue } = setup();
      await service.create(STEAM_ID, { size: 10, mime_type: "image/png" });
      const [, data] = queue.add.mock.calls[0] as unknown as [
        string,
        { id: string; objectKey: string; uploadId: string },
      ];

      await service.expireUpload(data.id, data.objectKey, data.uploadId, false);

      expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
        data.objectKey,
        data.uploadId,
      );
      await expect(service.complete(STEAM_ID, data.id)).resolves.toEqual({
        code: ChatErrorCode.NotFound,
      });
    });

    it("the abort job leaves a completed upload alone", async () => {
      const { service, s3, queue } = setup();
      await service.create(STEAM_ID, { size: 10, mime_type: "image/png" });
      const [, data] = queue.add.mock.calls[0] as unknown as [
        string,
        { id: string; objectKey: string; uploadId: string },
      ];
      await uploadAll(service, data.id, 10);
      await service.complete(STEAM_ID, data.id);

      await service.expireUpload(data.id, data.objectKey, data.uploadId, false);

      expect(s3.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it("a retried abort job aborts again and treats an upload already gone as done", async () => {
      const { service, s3, queue } = setup();
      await service.create(STEAM_ID, { size: 10, mime_type: "image/png" });
      const [, data] = queue.add.mock.calls[0] as unknown as [
        string,
        { id: string; objectKey: string; uploadId: string },
      ];
      s3.abortMultipartUpload.mockRejectedValueOnce(new Error("storage down"));

      await expect(
        service.expireUpload(data.id, data.objectKey, data.uploadId, false),
      ).rejects.toThrow("storage down");
      await expect(
        service.expireUpload(data.id, data.objectKey, data.uploadId, true),
      ).resolves.toBeUndefined();
      await expect(
        service.expireUpload(data.id, data.objectKey, data.uploadId, true),
      ).resolves.toBeUndefined();
    });
  });

  // Queue jobs are dispatched by job name to the class of that name.
  it("the abort job reaches its handler on the chat video queue", async () => {
    const attachments = { expireUpload: jest.fn(async () => undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: ChatAttachmentsService, useValue: attachments },
        AbortChatAttachmentUpload,
      ],
    }).compile();
    const processors = getQueuesProcessors("ChatVideo") as Array<
      new (logger: Logger, moduleRef: ModuleRef) => {
        process(job: unknown): Promise<void>;
      }
    >;
    const processor = new processors[0](
      { error: jest.fn() } as unknown as Logger,
      moduleRef.get(ModuleRef),
    );

    await processor.process({
      name: AbortChatAttachmentUploadJobName,
      attemptsMade: 1,
      data: { id: "id", objectKey: "key", uploadId: "upload" },
    });

    expect(attachments.expireUpload).toHaveBeenCalledWith(
      "id",
      "key",
      "upload",
      true,
    );
  });
});
