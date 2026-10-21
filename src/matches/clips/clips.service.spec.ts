jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { ClipsService } from "./clips.service";

describe("ClipsService", () => {
  let service: ClipsService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let gameStreamer: { killBatchHighlightsPod: jest.Mock };
  let batchQueue: { getJobs: jest.Mock; add: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn() };
    gameStreamer = { killBatchHighlightsPod: jest.fn() };
    batchQueue = { getJobs: jest.fn().mockResolvedValue([]), add: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new ClipsService(
      logger as any,
      hasura as any,
      {} as any,
      {} as any,
      gameStreamer as any,
      { release: jest.fn() } as any,
      { getConnection: jest.fn() } as any,
      batchQueue as any,
    );
  });

  describe("pauseClipRenderBatch", () => {
    it("resets in-flight rows to queued+paused with node cleared", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [{ match_map_demo_id: "demo-1" }],
      });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 3 },
      });

      const paused = await service.pauseClipRenderBatch("map-1");

      expect(paused).toBe(3);
      const updateArgs =
        hasura.mutation.mock.calls[0][0].update_clip_render_jobs.__args;
      expect(updateArgs._set).toEqual({
        paused: true,
        status: "queued",
        game_server_node_id: null,
      });
      expect(updateArgs.where.match_map_id._eq).toBe("map-1");
      expect(updateArgs.where.game_server_node_id).toBeUndefined();
    });

    it("scopes the UPDATE to game_server_node_id when nodeId is passed", async () => {
      hasura.query.mockResolvedValueOnce({ clip_render_jobs: [] });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 1 },
      });

      await service.pauseClipRenderBatch("map-1", "node-A");

      const updateWhere =
        hasura.mutation.mock.calls[0][0].update_clip_render_jobs.__args.where;
      expect(updateWhere.game_server_node_id).toEqual({ _eq: "node-A" });
    });

    it("kills the batch pod for each affected demo", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [
          { match_map_demo_id: "demo-1" },
          { match_map_demo_id: "demo-2" },
        ],
      });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 5 },
      });

      await service.pauseClipRenderBatch("map-1");

      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledTimes(2);
      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledWith(
        "map-1",
        "demo-1",
      );
      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledWith(
        "map-1",
        "demo-2",
      );
    });

    it("removes BullMQ entries matching the matchMapId", async () => {
      hasura.query.mockResolvedValueOnce({ clip_render_jobs: [] });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 0 },
      });
      const removeA = jest.fn();
      const removeB = jest.fn();
      batchQueue.getJobs.mockResolvedValueOnce([
        { data: { matchMapId: "map-1" }, remove: removeA },
        { data: { matchMapId: "other" }, remove: removeB },
      ]);

      await service.pauseClipRenderBatch("map-1");

      expect(removeA).toHaveBeenCalled();
      expect(removeB).not.toHaveBeenCalled();
    });
  });

  describe("isRenderResumeLocked", () => {
    it("locks when any active game-streamer row exists", async () => {
      hasura.query.mockResolvedValueOnce({ match_streams: [{ id: "s1" }] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(true);
    });

    it("unlocked when no streamer rows and toggle is off", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "false" } });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });

    it("unlocked when toggle setting row is missing", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: null });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });

    it("locks when toggle is on and a Live match has a GPU-server", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "true" } })
        .mockResolvedValueOnce({ matches: [{ id: "m1" }] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(true);
    });

    it("unlocked when toggle is on but no Live GPU-server match", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "true" } })
        .mockResolvedValueOnce({ matches: [] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });
  });

  describe("resumeClipRenderBatch", () => {
    it("no-ops when the lock is held", async () => {
      hasura.query.mockResolvedValueOnce({ match_streams: [{ id: "s1" }] });

      const cleared = await service.resumeClipRenderBatch("map-1");

      expect(cleared).toBe(0);
      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("clears paused and re-enqueues BullMQ per demo when unlocked", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "false" } });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 4 },
      });
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [
          { match_map_demo_id: "demo-1" },
          { match_map_demo_id: "demo-2" },
        ],
      });

      const cleared = await service.resumeClipRenderBatch("map-1");

      expect(cleared).toBe(4);
      expect(batchQueue.add).toHaveBeenCalledTimes(2);
    });
  });
});

describe("ClipsService clip deletion", () => {
  // Stored under the render job id, as finalizeClipUpload names them; auto
  // clips have no owner and live under clips/system/.
  const SYSTEM_CLIP = {
    id: "clip-1",
    user_steam_id: null,
    file: "clips/system/job-1.mp4",
    thumbnail_url: "clips/system/job-1.jpg",
  };

  function make(
    rows: { match_clips_by_pk?: unknown; match_clips?: unknown[] },
    stuck: string[] = [],
  ) {
    const objects = new Set([
      "clips/system/job-1.mp4",
      "clips/system/job-1.jpg",
      "clips/76561198000000001/job-2.mp4",
      "clips/system/job-10.mp4",
    ]);
    const hasura = {
      query: jest.fn(async () => rows),
      mutation: jest.fn(async () => ({})),
    };
    const s3 = {
      remove: jest.fn(async (key: string) =>
        stuck.includes(key) ? false : objects.delete(key),
      ),
      has: jest.fn(async (key: string) => objects.has(key)),
      removePrefix: jest.fn(),
    };
    const service = new ClipsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      {} as any,
      s3 as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, hasura, s3, objects };
  }

  // Upstream removed clips/<owner>/<clip id>, which matches no object.
  it("removes an auto clip's video and thumbnail by their stored keys", async () => {
    const { service, hasura, s3, objects } = make({
      match_clips_by_pk: SYSTEM_CLIP,
    });

    await service.deleteClip("76561198000000009", "clip-1", true);

    expect(objects.has("clips/system/job-1.mp4")).toBe(false);
    expect(objects.has("clips/system/job-1.jpg")).toBe(false);
    // Only the exact keys: job-10 shares the job-1 prefix.
    expect(objects.has("clips/system/job-10.mp4")).toBe(true);
    expect(s3.removePrefix).not.toHaveBeenCalled();
    expect(hasura.mutation).toHaveBeenCalledWith({
      delete_match_clips_by_pk: { __args: { id: "clip-1" }, id: true },
    });
  });

  it("keeps the row when the video could not be removed", async () => {
    const { service, hasura } = make({ match_clips_by_pk: SYSTEM_CLIP }, [
      "clips/system/job-1.mp4",
    ]);

    await expect(
      service.deleteClip("76561198000000009", "clip-1", true),
    ).rejects.toThrow("unable to remove the clip files, try again");
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("still refuses someone else's clip before touching any file", async () => {
    const { service, s3 } = make({
      match_clips_by_pk: { ...SYSTEM_CLIP, user_steam_id: "76561198000000001" },
    });

    await expect(
      service.deleteClip("76561198000000009", "clip-1", false),
    ).rejects.toThrow("you can only delete your own clips");
    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("never removes a key outside clips/", async () => {
    const { service, s3 } = make({
      match_clips_by_pk: {
        ...SYSTEM_CLIP,
        file: "demos/match-1/map-1/1-de_inferno.dem",
        thumbnail_url: null,
      },
    });

    await service.deleteClip("76561198000000009", "clip-1", true);

    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("removes every clip file of a deleted match", async () => {
    const { service, hasura, objects } = make({
      match_clips: [
        SYSTEM_CLIP,
        {
          id: "clip-2",
          file: "clips/76561198000000001/job-2.mp4",
          thumbnail_url: null,
        },
      ],
    });

    await service.deleteClipsForMatch("match-1");

    expect(objects.has("clips/system/job-1.mp4")).toBe(false);
    expect(objects.has("clips/system/job-1.jpg")).toBe(false);
    expect(objects.has("clips/76561198000000001/job-2.mp4")).toBe(false);
    expect(hasura.mutation).toHaveBeenCalledTimes(2);
  });
});
