import { PATH_METADATA } from "@nestjs/common/constants";
import { ChatService } from "./chat.service";
import { ChatVideoController } from "./chat-video.controller";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

describe("ChatVideoController routing", () => {
  it("uses the existing API ingress prefix", () => {
    expect(Reflect.getMetadata(PATH_METADATA, ChatVideoController)).toBe(
      "matches/chat-video",
    );
  });
});

describe("ChatService temporary video drafts", () => {
  const owner: User = {
    steam_id: "76561190000000123",
    name: "Player",
    role: "verified_user",
  };
  const stranger: User = {
    steam_id: "76561190000000456",
    name: "Other",
    role: "verified_user",
  };
  const values = new Map<string, string>();
  let service: ChatService;
  let s3: { put: jest.Mock; remove: jest.Mock };
  let redis: any;
  let expiryQueue: { add: jest.Mock };

  beforeEach(() => {
    values.clear();
    redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, ...args: any[]) => {
        if (args.includes("NX") && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }),
      del: jest.fn(async (...keys: string[]) =>
        keys.reduce((count, key) => count + Number(values.delete(key)), 0),
      ),
      expire: jest.fn().mockResolvedValue(1),
      hset: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue([1]),
      hgetall: jest.fn().mockResolvedValue({}),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(true),
      has: jest.fn().mockResolvedValue(false),
    };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      {} as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
      s3 as any,
      expiryQueue as any,
    );
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: owner });
  });

  it("hashes the phone capability, accepts a supported video signature once, and binds send to its owner and room", async () => {
    await service.updateChatMessageTTL(37);
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
    );
    expect(session).toBeDefined();
    expect(session!.token).toHaveLength(43);
    expect([...values.keys()].some((key) => key.includes(session!.token))).toBe(
      false,
    );

    const webm = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(256),
    ]);
    const uploaded = await service.uploadPhoneVideoDraft(
      session!.token,
      webm,
      "video/webm",
      10_000,
    );
    expect(uploaded).toEqual({ mediaId: expect.any(String) });
    await expect(
      service.getPhoneVideoDraft(session!.token),
    ).resolves.toBeUndefined();
    await expect(
      service.uploadOwnedVideoDraft(
        session!.id,
        stranger,
        webm,
        "video/webm",
        10_000,
      ),
    ).resolves.toBeUndefined();
    await expect(
      (service as any).consumeVideoDraft(
        session!.id,
        ChatLobbyType.Global,
        "other-room",
        owner,
      ),
    ).resolves.toBeUndefined();
    await expect(
      (service as any).consumeVideoDraft(
        session!.id,
        ChatLobbyType.Global,
        "global",
        stranger,
      ),
    ).resolves.toBeUndefined();
    const consumed = await (service as any).consumeVideoDraft(
      session!.id,
      ChatLobbyType.Global,
      "global",
      owner,
    );
    await expect(Promise.resolve(consumed)).resolves.toMatchObject({
      type: "video",
      mimeType: "video/webm",
      size: webm.length,
    });
    expect(expiryQueue.add).toHaveBeenCalledWith(
      "ExpireSentChatVideoMedia",
      {
        mediaId: uploaded!.mediaId,
        objectKey: expect.stringMatching(/^chat-video\/.+\.webm$/),
      },
      expect.objectContaining({ delay: 37 * 1000 + 60 * 60 * 1000 + 1000 }),
    );
    await expect(
      service.getVideoMediaForViewer(uploaded!.mediaId, owner),
    ).resolves.toBeUndefined();
    await service.cleanupExpiredSentVideoMedia(
      uploaded!.mediaId,
      `chat-video/${uploaded!.mediaId}.webm`,
    );
    expect(s3.remove).toHaveBeenCalledWith(
      `chat-video/${uploaded!.mediaId}.webm`,
    );
    expect(s3.put).toHaveBeenCalledWith(
      expect.stringMatching(/^chat-video\/.+\.webm$/),
      webm,
      "video/webm",
    );
  });

  it("expires the media lookup key with the same runtime TTL applied to its chat message", async () => {
    await service.updateChatMessageTTL(37);
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
    );
    const webm = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(256),
    ]);
    await service.uploadPhoneVideoDraft(
      session!.token,
      webm,
      "video/webm",
      10_000,
    );
    jest.spyOn(service as any, "to").mockImplementation(() => undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);

    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Global,
        "global",
        owner,
        "",
        true,
        "browser-session",
        session!.id,
      ),
    ).resolves.toMatchObject({ accepted: true });

    expect(redis.sendCommand).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire.mock.calls[0][0]).toMatch(
      /^chat_video_media:[0-9a-f-]{36}$/,
    );
    expect(redis.expire.mock.calls[0][1]).toBe(37);
  });

  it("rejects content whose magic bytes do not match the claimed MIME type", async () => {
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
    );
    await expect(
      service.uploadPhoneVideoDraft(
        session!.token,
        Buffer.from("not a video"),
        "video/webm",
        1000,
      ),
    ).resolves.toBeUndefined();
    expect(s3.put).not.toHaveBeenCalled();
  });
});
