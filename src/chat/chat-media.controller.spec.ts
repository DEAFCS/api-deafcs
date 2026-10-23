import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { NestExpressApplication } from "@nestjs/platform-express";
import http from "http";
import { AddressInfo } from "net";
import { Readable } from "stream";
import { registerBodyParsers } from "../body-parsers";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { ThrottlerBehindProxyGuard } from "../auth/strategies/ThrottlerBehindProxyGuard";
import { configureAttachmentUpload } from "./chat-attachment-upload";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatMediaController } from "./chat-media.controller";
import { ChatErrorCode } from "./enums/ChatErrorCode";

const STEAM_ID = "76561190000000001";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const attachments = {
  create: jest.fn(),
  uploadPart: jest.fn(),
  complete: jest.fn(),
  discard: jest.fn(),
};

@Module({
  controllers: [ChatMediaController],
  providers: [{ provide: ChatAttachmentsService, useValue: attachments }],
})
class MediaModule implements NestModule {
  // Registered as in chat.module.ts, to prove the single-request upload's raw
  // parser does not read the part routes' bodies first.
  configure(consumer: MiddlewareConsumer) {
    configureAttachmentUpload(consumer);
  }
}

describe("chat attachment part routes", () => {
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] })
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

    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    registerBodyParsers(app);
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  beforeEach(() => jest.resetAllMocks());

  function send(
    method: string,
    path: string,
    { type, body }: { type?: string; body?: Buffer | string } = {},
  ) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.request(
        {
          port,
          path,
          method,
          headers: {
            ...(type ? { "content-type": type } : {}),
            ...(body !== undefined
              ? { "content-length": Buffer.byteLength(body) }
              : {}),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              body: text ? JSON.parse(text) : undefined,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  it("creates an upload from the file's size and type", async () => {
    attachments.create.mockResolvedValue({ id: ID, part_size: 8, parts: 2 });

    const result = await send("POST", "/chat/attachments", {
      type: "application/json",
      body: JSON.stringify({ size: 16, mime_type: "video/mp4", name: "a.mp4" }),
    });

    expect(result).toEqual({
      status: 201,
      body: { id: ID, part_size: 8, parts: 2 },
    });
    expect(attachments.create).toHaveBeenCalledWith(STEAM_ID, {
      size: 16,
      mime_type: "video/mp4",
      name: "a.mp4",
    });
  });

  it("answers a refused create with its code", async () => {
    attachments.create.mockResolvedValue({ code: ChatErrorCode.TooLarge });

    const result = await send("POST", "/chat/attachments", {
      type: "application/json",
      body: JSON.stringify({ size: 1, mime_type: "video/mp4" }),
    });

    expect(result).toEqual({ status: 413, body: { code: "too_large" } });
  });

  it("hands the raw part body to the service unread", async () => {
    let received: Buffer | undefined;
    attachments.uploadPart.mockImplementation(
      async (_steamId, _id, _part, body: Readable, length: number) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        received = Buffer.concat(chunks);
        expect(length).toBe(received.length);
        return null;
      },
    );

    const result = await send("PUT", `/chat/attachments/${ID}/parts/2`, {
      type: "application/octet-stream",
      body: Buffer.alloc(1000, 7),
    });

    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(attachments.uploadPart).toHaveBeenCalledWith(
      STEAM_ID,
      ID,
      2,
      expect.anything(),
      1000,
    );
    expect(received).toEqual(Buffer.alloc(1000, 7));
  });

  it("refuses a part declared larger than a part can be, before reading it", async () => {
    const result = await new Promise<number>((resolve) => {
      const request = http.request(
        {
          port,
          path: `/chat/attachments/${ID}/parts/1`,
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": ChatAttachmentsService.PART_SIZE + 1,
          },
        },
        (response) => {
          response.resume();
          request.destroy();
          resolve(response.statusCode!);
        },
      );
      request.on("error", () => undefined);
      request.write(Buffer.alloc(1024));
    });

    expect(result).toBe(413);
    expect(attachments.uploadPart).not.toHaveBeenCalled();
  });

  it("refuses a part that is not a raw body", async () => {
    const result = await send("PUT", `/chat/attachments/${ID}/parts/1`, {
      type: "application/json",
      body: "{}",
    });

    expect(result.status).toBe(415);
    expect(attachments.uploadPart).not.toHaveBeenCalled();
  });

  it("answers a refused part with its code", async () => {
    attachments.uploadPart.mockResolvedValue(ChatErrorCode.RateLimited);

    const result = await send("PUT", `/chat/attachments/${ID}/parts/1`, {
      type: "application/octet-stream",
      body: Buffer.alloc(10),
    });

    expect(result).toEqual({ status: 429, body: { code: "rate_limited" } });
  });

  it("refuses an id that is not an upload id", async () => {
    const result = await send("POST", "/chat/attachments/../complete");
    expect(result.status).toBe(400);

    const notUuid = await send("POST", "/chat/attachments/abc/complete");
    expect(notUuid).toEqual({ status: 404, body: { code: "not_found" } });
    expect(attachments.complete).not.toHaveBeenCalled();
  });

  it("completes and discards", async () => {
    attachments.complete.mockResolvedValue({
      success: true,
      path: `chat-attachments/${STEAM_ID}/0123456789abcdef.mp4`,
      contentType: "video/mp4",
    });
    attachments.discard.mockResolvedValue(true);

    await expect(
      send("POST", `/chat/attachments/${ID}/complete`),
    ).resolves.toEqual({
      status: 201,
      body: {
        success: true,
        path: `chat-attachments/${STEAM_ID}/0123456789abcdef.mp4`,
        contentType: "video/mp4",
      },
    });
    await expect(send("DELETE", `/chat/attachments/${ID}`)).resolves.toEqual({
      status: 200,
      body: { success: true },
    });
    expect(attachments.discard).toHaveBeenCalledWith(STEAM_ID, ID);
  });
});
