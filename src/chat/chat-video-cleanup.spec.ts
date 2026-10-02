import { ChatService } from "./chat.service";
import { ExpireChatVideoDraft } from "./jobs/ExpireChatVideoDraft";
import { DelayedError } from "bullmq";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

describe("Live video retry-safe cleanup", () => {
  const id = "draft-1",
    mediaId = "12345678-1234-1234-1234-123456789abc";
  const objectKey = `chat-video/${mediaId}.webm`;
  const owner = {
    steam_id: "76561190000000123",
    role: "verified_user",
    name: "Player",
  } as any;
  let chat: any, values: Map<string, string>, redis: any, s3: any, queue: any;
  beforeEach(() => {
    values = new Map();
    redis = {
      get: jest.fn(async (key) => values.get(key) ?? null),
      set: jest.fn(async (key, value, ...args) => {
        if (args.includes("NX") && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }),
      del: jest.fn(async (...keys) =>
        keys.forEach((key) => values.delete(key)),
      ),
      ttl: jest.fn().mockResolvedValue(40),
      hget: jest.fn().mockResolvedValue(null),
      expire: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue([1]),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(true),
      has: jest.fn().mockResolvedValue(false),
    };
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    chat = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
      s3,
      queue,
    );
    values.set(
      `chat_video_media:${mediaId}`,
      JSON.stringify({ id: mediaId, objectKey }),
    );
    values.set(`chat_video_session_media:${id}`, mediaId);
    values.set(
      `chat_video_draft:${id}`,
      JSON.stringify({
        id,
        ownerSteamId: owner.steam_id,
        type: ChatLobbyType.Global,
        roomId: "global",
        state: "ready",
        mediaId,
        createdAt: Date.now(),
        tokenKey: "token-key",
      }),
    );
  });
  it("removes metadata after successful deletion and tolerates repeated cleanup", async () => {
    await chat.removeVideoMedia(mediaId);
    await chat.removeVideoMedia(mediaId);
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(false);
    expect(s3.remove).toHaveBeenCalledTimes(1);
  });
  it("retains metadata and pointer on S3 deletion failure", async () => {
    s3.remove.mockResolvedValue(false);
    s3.has.mockResolvedValue(true);
    await expect(chat.removeVideoMedia(mediaId)).rejects.toThrow();
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(true);
    expect(values.get(`chat_video_session_media:${id}`)).toBe(mediaId);
  });
  it("treats an already absent S3 object idempotently", async () => {
    s3.remove.mockResolvedValue(false);
    await chat.removeVideoMedia(mediaId);
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(false);
  });
  it("retake failure keeps the old media and ready state", async () => {
    s3.remove.mockResolvedValue(false);
    s3.has.mockResolvedValue(true);
    await expect(chat.retakeOwnedVideoDraft(id, owner)).rejects.toThrow();
    expect(JSON.parse(values.get(`chat_video_draft:${id}`)!)).toMatchObject({
      state: "ready",
      mediaId,
    });
    expect(values.get(`chat_video_session_media:${id}`)).toBe(mediaId);
  });
  it("cancel failure retains references for eventual expiry", async () => {
    s3.remove.mockResolvedValue(false);
    s3.has.mockResolvedValue(true);
    await expect(chat.cancelOwnedVideoDraft(id, owner)).rejects.toThrow();
    expect(values.has(`chat_video_draft:${id}`)).toBe(true);
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(true);
    s3.remove.mockResolvedValue(true);
    await chat.cleanupExpiredVideoDraft(id);
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(false);
  });
  it.each(["uploading", "sending", "retake", "cancel"])(
    "delays the same deterministic job beyond an active %s claim",
    async (claim) => {
      values.set(`chat_video_claim:${id}`, claim);
      const job = {
        data: { sessionId: id },
        token: "worker-token",
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
      };
      const worker = new ExpireChatVideoDraft(chat);
      await expect(worker.process(job as any)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(job.moveToDelayed).toHaveBeenCalledWith(
        expect.any(Number),
        "worker-token",
      );
      expect(job.moveToDelayed.mock.calls[0][0]).toBeGreaterThan(
        Date.now() + 39_000,
      );
      expect(s3.remove).not.toHaveBeenCalled();
      values.delete(`chat_video_claim:${id}`);
      await worker.process(job as any);
      expect(s3.remove).toHaveBeenCalledWith(objectKey);
    },
  );
  it("reconciles a successful send after the claim expires without deleting sent media", async () => {
    values.set(`chat_video_claim:${id}`, "sending");
    await chat.cleanupExpiredVideoDraft(id);
    values.delete(`chat_video_claim:${id}`);
    const session = JSON.parse(values.get(`chat_video_draft:${id}`)!);
    session.state = "sending";
    session.messageTtlSeconds = 86400;
    values.set(`chat_video_draft:${id}`, JSON.stringify(session));
    redis.hget.mockResolvedValue(
      JSON.stringify({
        id,
        media: { id: mediaId },
        from: { steam_id: owner.steam_id },
      }),
    );
    await chat.cleanupExpiredVideoDraft(id);
    expect(s3.remove).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(`chat_video_draft:${id}`)!)).toMatchObject({
      state: "sent",
    });
  });
  it.each([true, false])(
    "S3 PUT followed by Redis failure has cleanup when immediate deletion succeeds=%s",
    async (removed) => {
      const session = JSON.parse(values.get(`chat_video_draft:${id}`)!);
      session.state = "recording";
      delete session.mediaId;
      values.set(`chat_video_draft:${id}`, JSON.stringify(session));
      redis.set.mockImplementation(async (key, value, ...args) => {
        if (key.startsWith("chat_video_media:"))
          throw Error("Redis persistence failed");
        if (args.includes("NX") && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      });
      s3.remove.mockResolvedValue(removed);
      s3.has.mockResolvedValue(!removed);
      await expect(
        chat.uploadOwnedVideoDraft(
          id,
          owner,
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          "video/webm",
          1000,
        ),
      ).rejects.toThrow("Redis persistence failed");
      expect(queue.add).toHaveBeenCalledWith(
        "ExpireSentChatVideoMedia",
        {
          mediaId: expect.any(String),
          objectKey: expect.stringMatching(/^chat-video\/.+\.webm$/),
        },
        expect.objectContaining({
          attempts: 5,
          jobId: expect.stringMatching(/^chat-video-media-expiry-/),
        }),
      );
      expect(queue.add.mock.invocationCallOrder[0]).toBeLessThan(
        s3.put.mock.invocationCallOrder[0],
      );
      expect(s3.remove).toHaveBeenCalled();
    },
  );
  it("sent expiry keeps metadata on failure and retries idempotently", async () => {
    s3.remove.mockResolvedValue(false);
    s3.has.mockResolvedValue(true);
    await expect(
      chat.cleanupExpiredSentVideoMedia(mediaId, objectKey),
    ).rejects.toThrow();
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(true);
    s3.has.mockResolvedValue(false);
    await chat.cleanupExpiredSentVideoMedia(mediaId, objectKey);
    await chat.cleanupExpiredSentVideoMedia(mediaId, objectKey);
    expect(values.has(`chat_video_media:${mediaId}`)).toBe(false);
  });
});
