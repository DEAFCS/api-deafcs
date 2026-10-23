import { createHash, randomBytes } from "crypto";
import http from "http";
import { AddressInfo } from "net";
import { Logger, MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Client } from "minio";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { ThrottlerBehindProxyGuard } from "../auth/strategies/ThrottlerBehindProxyGuard";
import { registerBodyParsers } from "../body-parsers";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { S3Service } from "../s3/s3.service";
import { configureAttachmentUpload } from "./chat-attachment-upload";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatMediaController } from "./chat-media.controller";

// The part upload against a real S3 store, over HTTP, as the web sends it.
// Opt-in: set CHAT_UPLOAD_S3_ENDPOINT (host:port) to a disposable local store,
// e.g. the RustFS image production runs, with CHAT_UPLOAD_S3_KEY/_SECRET.

const ENDPOINT = process.env.CHAT_UPLOAD_S3_ENDPOINT;
const MB = 1024 * 1024;
const PART = ChatAttachmentsService.PART_SIZE;
const STEAM_ID = "76561190000000001";
const BUCKET = "chat-upload-test";

(ENDPOINT ? describe : describe.skip)("chat attachment parts in S3", () => {
  const [host, port] = (ENDPOINT ?? "127.0.0.1:9000").split(":");
  const config = {
    key: process.env.CHAT_UPLOAD_S3_KEY,
    secret: process.env.CHAT_UPLOAD_S3_SECRET,
    bucket: BUCKET,
    endpoint: host,
    port,
    useSSL: false,
  };
  const minio = new Client({
    endPoint: host,
    port: Number(port),
    useSSL: false,
    accessKey: config.key,
    secretKey: config.secret,
  });
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
  };
  const queue = { add: jest.fn(async () => ({})), remove: jest.fn(async () => 1) };

  let app: NestExpressApplication;
  let attachments: ChatAttachmentsService;
  let api: number;

  @Module({
    controllers: [ChatMediaController],
    providers: [
      { provide: Logger, useValue: new Logger("test") },
      { provide: ConfigService, useValue: { get: () => config } },
      S3Service,
      { provide: RedisManagerService, useValue: { getConnection: () => redis } },
      {
        provide: ChatAttachmentsService,
        inject: [Logger, S3Service, RedisManagerService],
        useFactory: (logger: Logger, s3: S3Service, manager: RedisManagerService) =>
          new ChatAttachmentsService(logger, s3, manager, queue as any),
      },
    ],
  })
  class StorageModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      configureAttachmentUpload(consumer);
    }
  }

  beforeAll(async () => {
    // S3Service also builds a client for the public demos domain; unused here.
    process.env.DEMOS_DOMAIN ??= "demos.example.invalid";
    if (!(await minio.bucketExists(BUCKET))) await minio.makeBucket(BUCKET);

    const moduleRef = await Test.createTestingModule({ imports: [StorageModule] })
      .overrideGuard(SteamGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { steam_id: STEAM_ID };
          return true;
        },
      })
      .overrideGuard(ThrottlerBehindProxyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    attachments = moduleRef.get(ChatAttachmentsService);
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    registerBodyParsers(app);
    await app.listen(0, "127.0.0.1");
    api = (app.getHttpServer().address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  function call(
    method: string,
    path: string,
    body?: Buffer | object,
  ): Promise<{ status: number; body: any }> {
    const raw = Buffer.isBuffer(body);
    const payload = body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          port: api,
          path,
          method,
          headers: payload
            ? {
                "content-type": raw ? "application/octet-stream" : "application/json",
                "content-length": payload.length,
              }
            : {},
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : undefined }),
          );
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
  }

  async function create(size: number, mimeType = "video/mp4") {
    const created = await call("POST", "/chat/attachments", {
      name: "clip.mp4",
      size,
      mime_type: mimeType,
    });
    expect(created.status).toBe(201);
    return created.body as { id: string; part_size: number; parts: number };
  }

  function putPart(id: string, file: Buffer, part: number) {
    return call(
      "PUT",
      `/chat/attachments/${id}/parts/${part}`,
      file.subarray((part - 1) * PART, Math.min(part * PART, file.length)),
    );
  }

  function record(id: string) {
    return JSON.parse(store.get(`chat_attachment_upload:${id}`)!) as {
      objectKey: string;
      uploadId: string;
    };
  }

  async function incompleteUploads(key: string) {
    const found: string[] = [];
    for await (const upload of minio.listIncompleteUploads(BUCKET, key, true)) {
      if (upload.key === key) found.push(upload.uploadId);
    }
    return found;
  }

  async function exists(key: string) {
    try {
      await minio.statObject(BUCKET, key);
      return true;
    } catch {
      return false;
    }
  }

  it("stores the reported 107 MB video intact from 13 parts", async () => {
    const size = 107_418_289;
    const file = randomBytes(size);
    const { id, parts } = await create(size);
    expect(parts).toBe(13);
    const { objectKey } = record(id);

    // Two at a time, as the web sends them.
    for (let part = 1; part <= parts; part += 2) {
      const sent = await Promise.all(
        [part, part + 1].filter((n) => n <= parts).map((n) => putPart(id, file, n)),
      );
      expect(sent.map((result) => result.status)).toEqual(sent.map(() => 200));
    }

    const completed = await call("POST", `/chat/attachments/${id}/complete`);
    expect(completed).toEqual({
      status: 201,
      body: { success: true, path: objectKey, contentType: "video/mp4" },
    });

    expect((await minio.statObject(BUCKET, objectKey)).size).toBe(size);
    const hash = createHash("sha256");
    for await (const chunk of await minio.getObject(BUCKET, objectKey)) hash.update(chunk);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(file).digest("hex"));
    expect(await incompleteUploads(objectKey)).toEqual([]);

    await minio.removeObject(BUCKET, objectKey);
  }, 300_000);

  it("keeps a part that arrived short out of the file", async () => {
    const file = randomBytes(2 * PART);
    const { id } = await create(file.length);
    const { objectKey } = record(id);

    // Declares a whole part, sends half, then drops the connection.
    await new Promise<void>((resolve) => {
      const request = http.request({
        port: api,
        path: `/chat/attachments/${id}/parts/1`,
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": PART },
      });
      request.on("error", () => resolve());
      request.write(file.subarray(0, PART / 2), () => setTimeout(() => {
        request.destroy();
        resolve();
      }, 200));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect((await putPart(id, file, 1)).status).toBe(200);
    expect((await putPart(id, file, 2)).status).toBe(200);
    const completed = await call("POST", `/chat/attachments/${id}/complete`);
    expect(completed.status).toBe(201);

    const hash = createHash("sha256");
    for await (const chunk of await minio.getObject(BUCKET, objectKey)) hash.update(chunk);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(file).digest("hex"));
    await minio.removeObject(BUCKET, objectKey);
  }, 60_000);

  it("discarding mid-upload removes the parts already sent", async () => {
    const file = randomBytes(3 * PART);
    const { id } = await create(file.length);
    const { objectKey } = record(id);
    expect((await putPart(id, file, 1)).status).toBe(200);
    expect((await putPart(id, file, 2)).status).toBe(200);
    expect(await incompleteUploads(objectKey)).toHaveLength(1);

    expect(await call("DELETE", `/chat/attachments/${id}`)).toEqual({
      status: 200,
      body: { success: true },
    });

    expect(await incompleteUploads(objectKey)).toEqual([]);
    expect(await exists(objectKey)).toBe(false);
    expect((await putPart(id, file, 3)).status).toBe(404);
    expect((await call("POST", `/chat/attachments/${id}/complete`)).status).toBe(404);
  }, 60_000);

  it("the abort job removes an upload nobody finished, and is safe to repeat", async () => {
    const file = randomBytes(2 * PART);
    const { id } = await create(file.length);
    const { objectKey, uploadId } = record(id);
    expect((await putPart(id, file, 1)).status).toBe(200);

    await attachments.expireUpload(id, objectKey, uploadId, false);
    expect(await incompleteUploads(objectKey)).toEqual([]);

    // A retried job finds the upload already gone in storage.
    await expect(attachments.expireUpload(id, objectKey, uploadId, true)).resolves.toBeUndefined();
    expect((await putPart(id, file, 2)).status).toBe(404);
  }, 60_000);

  it("refuses to complete a file missing a part, and leaves nothing behind", async () => {
    const file = randomBytes(2 * PART);
    const { id } = await create(file.length);
    const { objectKey } = record(id);
    expect((await putPart(id, file, 1)).status).toBe(200);

    const completed = await call("POST", `/chat/attachments/${id}/complete`);
    expect(completed).toEqual({ status: 400, body: { code: "invalid" } });
    expect(await exists(objectKey)).toBe(false);
    expect(await incompleteUploads(objectKey)).toEqual([]);
  }, 60_000);

  it("keeps the 200 MB limit", async () => {
    const over = await call("POST", "/chat/attachments", {
      size: 200 * MB + 1,
      mime_type: "video/mp4",
    });
    expect(over).toEqual({ status: 413, body: { code: "too_large" } });

    const { id, parts } = await create(200 * MB);
    expect(parts).toBe(25);
    const { objectKey } = record(id);
    expect((await call("DELETE", `/chat/attachments/${id}`)).status).toBe(200);
    expect(await incompleteUploads(objectKey)).toEqual([]);
  }, 60_000);
});
