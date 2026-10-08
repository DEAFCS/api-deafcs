jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { UnauthorizedException } from "@nestjs/common";
import { ClipsService } from "./clips.service";
import { ClipViewsController } from "./clip-views.controller";

const FILE = "clips/system/4d12968c-ed12-402e-a6bd-21543009f0e3.mp4";
const VIEWER_A = "a".repeat(32);
const VIEWER_B = "b".repeat(32);

describe("ClipsService.registerStreamedClipView", () => {
  let hasura: { mutation: jest.Mock };
  let redis: { set: jest.Mock; del: jest.Mock };
  let service: ClipsService;
  const claimed = new Set<string>();

  beforeEach(() => {
    claimed.clear();
    hasura = {
      mutation: jest
        .fn()
        .mockResolvedValue({ update_match_clips: { affected_rows: 1 } }),
    };
    // Behaves like Redis SET key value EX ttl NX.
    redis = {
      set: jest.fn(async (key: string) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return "OK";
      }),
      del: jest.fn(async (key: string) => {
        claimed.delete(key);
        return 1;
      }),
    };
    service = new ClipsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
    );
  });

  it("A: the first view increments views_count by 1 on the row with that exact file", async () => {
    await expect(
      service.registerStreamedClipView(FILE, VIEWER_A),
    ).resolves.toBe(true);
    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    const args = hasura.mutation.mock.calls[0][0].update_match_clips.__args;
    expect(args.where).toEqual({ file: { _eq: FILE } });
    expect(args._inc).toEqual({ views_count: 1 });
  });

  it("B: the same viewer within the window does not count again", async () => {
    await service.registerStreamedClipView(FILE, VIEWER_A);
    await expect(
      service.registerStreamedClipView(FILE, VIEWER_A),
    ).resolves.toBe(false);
    expect(hasura.mutation).toHaveBeenCalledTimes(1);
  });

  it("the dedupe window is 6 hours", async () => {
    await service.registerStreamedClipView(FILE, VIEWER_A);
    expect(redis.set).toHaveBeenCalledWith(
      `clip-view:${FILE}:${VIEWER_A}`,
      "1",
      "EX",
      6 * 60 * 60,
      "NX",
    );
  });

  it("C: a different viewer counts", async () => {
    await service.registerStreamedClipView(FILE, VIEWER_A);
    await expect(
      service.registerStreamedClipView(FILE, VIEWER_B),
    ).resolves.toBe(true);
    expect(hasura.mutation).toHaveBeenCalledTimes(2);
  });

  it("the same viewer can count a different clip", async () => {
    await service.registerStreamedClipView(FILE, VIEWER_A);
    await expect(
      service.registerStreamedClipView("clips/system/other.mp4", VIEWER_A),
    ).resolves.toBe(true);
  });

  it("a failed increment releases the claim so the view is not lost for 6 hours", async () => {
    hasura.mutation.mockRejectedValueOnce(new Error("hasura down"));
    await expect(
      service.registerStreamedClipView(FILE, VIEWER_A),
    ).rejects.toThrow("hasura down");
    expect(redis.del).toHaveBeenCalledWith(`clip-view:${FILE}:${VIEWER_A}`);

    await expect(
      service.registerStreamedClipView(FILE, VIEWER_A),
    ).resolves.toBe(true);
  });
});

describe("ClipViewsController (Worker beacon)", () => {
  const previousSecret = process.env.S3_SECRET;
  let clips: { registerStreamedClipView: jest.Mock };
  let controller: ClipViewsController;

  beforeEach(() => {
    process.env.S3_SECRET = "test-worker-secret";
    clips = { registerStreamedClipView: jest.fn().mockResolvedValue(true) };
    controller = new ClipViewsController(clips as any);
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.S3_SECRET;
    else process.env.S3_SECRET = previousSecret;
  });

  it("K: rejects a missing or wrong bearer and never counts", async () => {
    await expect(
      controller.play(undefined, { file: FILE, clientKey: VIEWER_A }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.play("Bearer wrong", { file: FILE, clientKey: VIEWER_A }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("K: rejects everything when no secret is configured", async () => {
    delete process.env.S3_SECRET;
    await expect(
      controller.play("Bearer ", { file: FILE, clientKey: VIEWER_A }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("counts with a valid bearer", async () => {
    await expect(
      controller.play("Bearer test-worker-secret", {
        file: FILE,
        clientKey: VIEWER_A,
      }),
    ).resolves.toEqual({ success: true, counted: true });
    expect(clips.registerStreamedClipView).toHaveBeenCalledWith(FILE, VIEWER_A);
  });

  it("J: refuses a file outside clips/*.mp4 or a malformed viewer key", async () => {
    for (const body of [
      { file: "demos/x.mp4", clientKey: VIEWER_A },
      { file: "clips/x.png", clientKey: VIEWER_A },
      { file: FILE, clientKey: "NOT-HEX" },
      { file: FILE },
      {},
    ]) {
      await expect(
        controller.play("Bearer test-worker-secret", body),
      ).resolves.toEqual({ success: false });
    }
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });
});
