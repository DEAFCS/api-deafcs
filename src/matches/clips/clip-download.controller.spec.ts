jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { Readable, Writable } from "stream";
import { ClipDownloadController } from "./clip-download.controller";

const FILE = "clips/system/4d12968c-ed12-402e-a6bd-21543009f0e3.mp4";
const CLIP_ID = "166d93b9-1421-48a7-a40a-cb3a7135ea21";
const SIZE = 1000;
const chrome =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function chunks(total: number, pieces = 5): Array<Buffer> {
  const each = Math.floor(total / pieces);
  const list = Array.from({ length: pieces }, () => Buffer.alloc(each));
  list[pieces - 1] = Buffer.alloc(total - each * (pieces - 1));
  return list;
}

describe("ClipDownloadController view counting", () => {
  let hasura: { query: jest.Mock };
  let s3: { stat: jest.Mock; get: jest.Mock; getPartial: jest.Mock };
  let clips: { registerStreamedClipView: jest.Mock };
  let logger: { warn: jest.Mock; error: jest.Mock };
  let controller: ClipDownloadController;

  beforeEach(() => {
    hasura = {
      query: jest.fn().mockResolvedValue({
        match_clips_by_pk: { file: FILE, thumbnail_url: null },
      }),
    };
    s3 = {
      stat: jest.fn().mockResolvedValue({ size: SIZE }),
      get: jest
        .fn()
        .mockImplementation(async () => Readable.from(chunks(SIZE))),
      getPartial: jest
        .fn()
        .mockImplementation(
          async (_key: string, _start: number, length: number) =>
            Readable.from(chunks(length)),
        ),
    };
    clips = { registerStreamedClipView: jest.fn().mockResolvedValue(true) };
    logger = { warn: jest.fn(), error: jest.fn() };
    controller = new ClipDownloadController(
      s3 as any,
      hasura as any,
      clips as any,
      logger as any,
    );
  });

  async function play(
    opts: {
      method?: string;
      range?: string;
      dl?: string;
      download?: string;
      noview?: string;
      userAgent?: string;
      ip?: string;
      clipId?: string;
    } = {},
  ) {
    const response: any = new Writable({
      write(_chunk, _enc, callback) {
        callback();
      },
    });
    response.headers = {} as Record<string, unknown>;
    response.statusCode = 200;
    response.setHeader = (k: string, v: unknown) => {
      response.headers[k] = v;
    };
    response.status = (code: number) => {
      response.statusCode = code;
      return response;
    };
    response.json = jest.fn(() => response);
    const finished = new Promise((resolve) => response.on("finish", resolve));

    const request: any = {
      method: opts.method ?? "GET",
      ip: "10.0.0.1",
      headers: {
        ...(opts.range ? { range: opts.range } : {}),
        "user-agent": opts.userAgent ?? chrome,
        "cf-connecting-ip": opts.ip ?? "203.0.113.9",
      },
    };

    await controller.download(
      opts.clipId ?? CLIP_ID,
      "clip.mp4",
      opts.dl,
      opts.download,
      opts.noview,
      request,
      response,
    );
    if (response.json.mock.calls.length === 0) {
      await finished;
    }
    // The count is fired from the data listener; let its promise settle.
    await new Promise((resolve) => setImmediate(resolve));
    return response;
  }

  it("A/I: a first full playback counts one view using the exact stored file", async () => {
    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toBe("video/mp4");
    expect(clips.registerStreamedClipView).toHaveBeenCalledTimes(1);
    const [file, clientKey] = clips.registerStreamedClipView.mock.calls[0];
    expect(file).toBe(FILE);
    expect(clientKey).toMatch(/^[a-f0-9]{32}$/);
  });

  it("counts a ranged playback from the start that reaches the middle", async () => {
    const response = await play({ range: "bytes=0-" });
    expect(response.statusCode).toBe(206);
    expect(clips.registerStreamedClipView).toHaveBeenCalledTimes(1);
  });

  it("H: a range that starts before and crosses the middle counts", async () => {
    await play({ range: "bytes=400-699" });
    expect(clips.registerStreamedClipView).toHaveBeenCalledTimes(1);
  });

  it("G: a range that stops short of the middle does not count", async () => {
    const response = await play({ range: "bytes=0-99" });
    expect(response.statusCode).toBe(206);
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("a tail seek or end-of-file probe does not count", async () => {
    await play({ range: "bytes=900-999" });
    await play({ range: "bytes=-100" });
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("a playback aborted before the middle does not count", async () => {
    s3.get.mockImplementation(async () =>
      Readable.from(chunks(SIZE).slice(0, 2)),
    );
    await play();
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("C: different viewers each reach the counter with their own key", async () => {
    await play({ ip: "203.0.113.9" });
    await play({ ip: "203.0.113.10" });
    const keys = clips.registerStreamedClipView.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("the same viewer always sends the same key (dedupe happens in the service)", async () => {
    await play();
    await play();
    const keys = clips.registerStreamedClipView.mock.calls.map((c) => c[1]);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each([
    ["D: a download (dl=1)", { dl: "1" }],
    ["D: a download (download=1)", { download: "1" }],
    ["E: noview=1", { noview: "1" }],
    ["F: a bot", { userAgent: "Mozilla/5.0 (compatible; Discordbot/2.0)" }],
    ["a HEAD request", { method: "HEAD" }],
  ])("%s does not count", async (_name, opts) => {
    const response = await play(opts);
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
    // playback itself is unaffected
    expect([200, 206]).toContain(response.statusCode);
  });

  it("J: a clip that does not exist is not streamed or counted", async () => {
    hasura.query.mockResolvedValue({ match_clips_by_pk: null });
    const response = await play();
    expect(response.statusCode).toBe(404);
    expect(s3.stat).not.toHaveBeenCalled();
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("J: a clip whose file is missing in storage is not counted", async () => {
    s3.stat.mockRejectedValue({ code: "NotFound" });
    const response = await play();
    expect(response.statusCode).toBe(404);
    expect(clips.registerStreamedClipView).not.toHaveBeenCalled();
  });

  it("a failing counter never breaks playback and never logs the viewer key", async () => {
    clips.registerStreamedClipView.mockRejectedValue(new Error("hasura down"));
    const response = await play();
    expect(response.statusCode).toBe(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls[0][0]);
    expect(message).toContain(FILE);
    expect(message).not.toMatch(/[a-f0-9]{32}/);
    expect(message).not.toContain("203.0.113.9");
  });
});
