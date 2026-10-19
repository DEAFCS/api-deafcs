import { INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import http from "http";
import { AddressInfo } from "net";
import { ClipRendersController } from "./matches/clips/clip-renders.controller";
import { ClipsService } from "./matches/clips/clips.service";
import { DemoSessionsController } from "./matches/game-streamer/demo-sessions.controller";
import { GameServerNodeBakeController } from "./matches/game-streamer/game-server-node-bake.controller";
import { GameStreamerController } from "./matches/game-streamer/game-streamer.controller";
import { GameStreamerService } from "./matches/game-streamer/game-streamer.service";
import { StreamAccessService } from "./matches/game-streamer/stream-access.service";
import { UtilityRendersController } from "./utility/utility-renders.controller";
import { UtilityRendersService } from "./utility/utility-renders.service";
import { UtilityLaunchSeedService } from "./utility/utility-launch-seed.service";
import { UtilityPracticeService } from "./utility/utility-practice.service";

// DEAFCS: the streamer, demo, bake, clip and lineup pods post a still every
// few seconds. Each still is at most 2MB, so multer stops reading there, and
// a demo still is only taken for a demo session that exists (its pod has no
// secret of its own). Same raw-http approach as upload-routes.spec.ts.

const MB = 1024 * 1024;
const MATCH = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const SESSION = "7c6b5a49-3827-4615-8a4b-3c2d1e0f9a8b";
const NODE = "node-1";
const JOB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TOKEN = "pod-token";

const ROUTES: Array<{ name: string; path: string; auth: string }> = [
  {
    name: "live",
    path: `/game-streamer/${MATCH}/snapshot`,
    auth: `${MATCH}:${TOKEN}`,
  },
  { name: "demo", path: `/demo-sessions/${SESSION}/snapshot`, auth: SESSION },
  { name: "bake", path: `/game-server-nodes/${NODE}/snapshot`, auth: NODE },
  {
    name: "clips",
    path: `/clip-renders/${JOB}/snapshot`,
    auth: `${JOB}:${TOKEN}`,
  },
  {
    name: "nades",
    path: `/nade-renders/${JOB}/snapshot`,
    auth: `${JOB}:${TOKEN}`,
  },
];

const BOUNDARY = "deafcs-snapshot-boundary";

describe("pod snapshot routes", () => {
  let app: INestApplication;
  let port: number;
  let storeSnapshot: jest.Mock;
  let isDemoSession: jest.Mock;

  const post = async (
    path: string,
    auth: string | undefined,
    size: number,
    extraField = false,
  ) => {
    const head = Buffer.from(
      (extraField
        ? `--${BOUNDARY}\r\n` +
          'Content-Disposition: form-data; name="note"\r\n\r\n' +
          "hello\r\n"
        : "") +
        `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="snapshot.jpg"\r\n' +
        "Content-Type: image/jpeg\r\n\r\n",
    );
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

    const request = http.request({
      port,
      method: "POST",
      path,
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": head.length + size + tail.length,
        ...(auth ? { "x-origin-auth": auth } : {}),
      },
    });

    const status = new Promise<number>((resolve, reject) => {
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        // The server may answer and close before the rest is written.
        if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
          reject(error);
        }
      });
    });

    request.write(head);
    const chunk = Buffer.alloc(MB, 0xff);
    for (let sent = 0; sent < size; sent += chunk.length) {
      const piece = chunk.subarray(0, Math.min(chunk.length, size - sent));
      if (!request.write(piece)) {
        await Promise.race([
          new Promise((resolve) => request.once("drain", resolve)),
          status,
        ]);
      }
    }
    request.end(tail);

    return await status;
  };

  beforeEach(async () => {
    storeSnapshot = jest.fn().mockResolvedValue(undefined);
    isDemoSession = jest.fn(async (id: string) => id === SESSION);
    const podAuth = async (id: string, header: unknown) =>
      header === `${id}:${TOKEN}` ? { id } : null;

    const module = await Test.createTestingModule({
      controllers: [
        GameStreamerController,
        DemoSessionsController,
        GameServerNodeBakeController,
        ClipRendersController,
        UtilityRendersController,
      ],
      providers: [
        {
          provide: GameStreamerService,
          useValue: {
            storeSnapshot,
            isDemoSession,
            validateStatusOriginAuth: jest.fn(
              async (id: string, header: unknown) =>
                header === `${id}:${TOKEN}`,
            ),
          },
        },
        { provide: StreamAccessService, useValue: {} },
        {
          provide: ClipsService,
          useValue: { validateClipRenderAuth: jest.fn(podAuth) },
        },
        {
          provide: UtilityRendersService,
          useValue: { validateRenderAuth: jest.fn(podAuth) },
        },
        { provide: UtilityLaunchSeedService, useValue: {} },
        { provide: UtilityPracticeService, useValue: {} },
        {
          provide: Logger,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(ROUTES)("$name stores a pod's still", async ({ name, path, auth }) => {
    expect(await post(path, auth, 200 * 1024)).toBe(204);
    expect(storeSnapshot).toHaveBeenCalledWith(
      name,
      expect.any(String),
      expect.any(Buffer),
    );
  });

  it.each(ROUTES)(
    "$name stops reading a still past 2MB",
    async ({ path, auth }) => {
      expect(await post(path, auth, 2 * MB + MB)).toBe(413);
      expect(storeSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    "$name takes nothing but the file",
    async ({ path, auth }) => {
      expect(await post(path, auth, 1024, true)).toBe(400);
      expect(storeSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.filter((route) => route.name !== "demo"))(
    "$name refuses a still without the pod's credentials",
    async ({ path }) => {
      expect([401, 403]).toContain(await post(path, "wrong:auth", 1024));
      expect(await post(path, undefined, 1024)).toBeGreaterThanOrEqual(401);
      expect(storeSnapshot).not.toHaveBeenCalled();
    },
  );

  it("refuses a demo still for a session that does not exist", async () => {
    const other = "00000000-0000-4000-8000-000000000000";

    expect(await post(`/demo-sessions/${other}/snapshot`, other, 1024)).toBe(
      404,
    );
    expect(isDemoSession).toHaveBeenCalledWith(other);
    expect(storeSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a demo still when the session cannot be looked up", async () => {
    isDemoSession.mockRejectedValueOnce(new Error("hasura is down"));

    expect(
      await post(`/demo-sessions/${SESSION}/snapshot`, SESSION, 1024),
    ).toBe(404);
    expect(storeSnapshot).not.toHaveBeenCalled();
  });
});
