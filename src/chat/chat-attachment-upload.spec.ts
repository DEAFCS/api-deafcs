import {
  Controller,
  HttpCode,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  Req,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { NextFunction, Request, Response } from "express";
import http from "http";
import { AddressInfo } from "net";
import { registerBodyParsers } from "../body-parsers";
import { configureAttachmentUpload } from "./chat-attachment-upload";

// DEAFCS Security Batch 3. The raw chat attachment parser buffered up to 210mb
// of any request, signed in or not, before the controller's own checks ran.
// The gate refuses those requests before reading the body.

const MB = 1024 * 1024;
const STEAM_ID = "76561190000000001";

@Controller("chat")
class AttachmentController {
  public static received: number | undefined;

  @Post("attachment")
  @HttpCode(200)
  public upload(@Req() request: Request) {
    AttachmentController.received = Buffer.isBuffer(request.body)
      ? request.body.length
      : -1;
    return { bytes: AttachmentController.received };
  }
}

@Module({ controllers: [AttachmentController] })
class AttachmentModule implements NestModule {
  public configure(consumer: MiddlewareConsumer) {
    configureAttachmentUpload(consumer);
  }
}

describe("chat attachment upload gate", () => {
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AttachmentModule, {
      logger: false,
    });
    // Same order as main.ts: body parsers, then the session (passport sets
    // request.user), then the module middleware at init.
    registerBodyParsers(app);
    app.use((request: Request, _response: Response, next: NextFunction) => {
      if (request.headers["x-test-user"]) {
        (request as any).user = { steam_id: STEAM_ID, role: "user" };
      }
      next();
    });
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    AttachmentController.received = undefined;
  });

  // Sends the headers and `sent` bytes of a body declared as `declared`
  // bytes, then waits: only an answer that needs no more of the body arrives.
  function upload({
    signedIn,
    type,
    declared,
    sent = declared,
  }: {
    signedIn: boolean;
    type: string;
    declared: number;
    sent?: number;
  }) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no answer without the body")),
        5000,
      );
      const request = http.request(
        {
          port,
          path: "/chat/attachment",
          method: "POST",
          headers: {
            "content-type": type,
            "content-length": declared,
            ...(signedIn ? { "x-test-user": "1" } : {}),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            clearTimeout(timer);
            // A half-sent body would otherwise hold the connection open.
            request.destroy();
            resolve({ status: response.statusCode!, body: JSON.parse(text) });
          });
        },
      );
      request.on("error", () => undefined);
      request.write(Buffer.alloc(sent, 1));
      if (sent === declared) request.end();
    });
  }

  it("refuses a signed-out upload without reading it", async () => {
    const result = await upload({
      signedIn: false,
      type: "video/mp4",
      declared: 150 * MB,
      sent: 1024,
    });

    expect(result.status).toBe(403);
    expect(AttachmentController.received).toBeUndefined();
  });

  it("refuses a type it does not take without reading it", async () => {
    const result = await upload({
      signedIn: true,
      type: "application/octet-stream",
      declared: 150 * MB,
      sent: 1024,
    });

    expect(result.status).toBe(400);
    expect(AttachmentController.received).toBeUndefined();
  });

  it("refuses a declared size over 200mb without reading it", async () => {
    const result = await upload({
      signedIn: true,
      type: "video/mp4",
      declared: 205 * MB,
      sent: 1024,
    });

    expect(result.status).toBe(413);
    expect(AttachmentController.received).toBeUndefined();
  });

  it("still takes a signed-in player's video, whole", async () => {
    const result = await upload({
      signedIn: true,
      type: "video/mp4; codecs=avc1",
      declared: 5 * MB,
    });

    expect(result.status).toBe(200);
    expect(result.body.bytes).toBe(5 * MB);
  });

  it("still takes an image", async () => {
    const result = await upload({
      signedIn: true,
      type: "image/png",
      declared: 64 * 1024,
    });

    expect(result.status).toBe(200);
    expect(result.body.bytes).toBe(64 * 1024);
  });
});
