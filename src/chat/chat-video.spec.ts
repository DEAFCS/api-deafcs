import { PATH_METADATA } from "@nestjs/common/constants";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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

describe("ChatVideoController upload routes", () => {
  const owner: User = {
    steam_id: "76561190000000123",
    name: "Player",
    role: "verified_user",
  };
  const token = "T".repeat(43);
  const file = {
    buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    mimetype: "video/webm;codecs=vp9",
  } as Express.Multer.File;
  const body = { durationMs: "10000" };

  it("routes PC uploads through the authenticated owner-bound draft service", async () => {
    const chat = {
      uploadOwnedVideoDraft: jest
        .fn()
        .mockResolvedValue({ mediaId: "media-1" }),
    };
    const controller = new ChatVideoController(
      chat as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.directUpload("draft-1", { user: owner } as any, file, body),
    ).resolves.toEqual({ success: true });
    expect(chat.uploadOwnedVideoDraft).toHaveBeenCalledWith(
      "draft-1",
      owner,
      file.buffer,
      file.mimetype,
      10_000,
    );
  });

  it("accepts the phone capability route without a request.user", async () => {
    const chat = {
      uploadPhoneVideoDraft: jest
        .fn()
        .mockResolvedValue({ mediaId: "media-1" }),
    };
    const controller = new ChatVideoController(
      chat as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.phoneUpload(`Bearer ${token}`, file, body),
    ).resolves.toEqual({ success: true });
    expect(chat.uploadPhoneVideoDraft).toHaveBeenCalledWith(
      token,
      file.buffer,
      file.mimetype,
      10_000,
    );
  });

  it("sends a PC video using only the authenticated draft id", async () => {
    const chat = {
      sendOwnedVideoDraft: jest.fn().mockResolvedValue({ accepted: true }),
    };
    const controller = new ChatVideoController(
      chat as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.sendOwned("draft-1", { user: owner } as any),
    ).resolves.toEqual({ success: true });
    expect(chat.sendOwnedVideoDraft).toHaveBeenCalledWith("draft-1", owner);
  });

  it("sends a phone video using only its capability token", async () => {
    const chat = {
      sendPhoneVideoDraft: jest.fn().mockResolvedValue({ accepted: true }),
    };
    const controller = new ChatVideoController(
      chat as any,
      {} as any,
      {} as any,
    );

    await expect(controller.sendPhone(`Bearer ${token}`)).resolves.toEqual({
      success: true,
    });
    expect(chat.sendPhoneVideoDraft).toHaveBeenCalledWith(token);
  });

  it("rejects an expired phone capability before upload", async () => {
    const chat = {
      getPhoneVideoDraft: jest.fn().mockResolvedValue(undefined),
      uploadPhoneVideoDraft: jest.fn(),
    };
    const controller = new ChatVideoController(
      chat as any,
      {} as any,
      {} as any,
    );

    await expect(
      controller.phoneStatus(`Bearer ${token}`),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.phoneUpload(`Bearer ${token}`, file, body),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chat.uploadPhoneVideoDraft).toHaveBeenCalledTimes(1);
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
  const hashes = new Map<string, Map<string, string>>();
  let service: ChatService;
  let s3: { put: jest.Mock; remove: jest.Mock };
  let redis: any;
  let expiryQueue: { add: jest.Mock };

  beforeEach(() => {
    values.clear();
    hashes.clear();
    redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, ...args: any[]) => {
        if (args.includes("NX") && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }),
      del: jest.fn(async (...keys: string[]) =>
        keys.reduce(
          (count, key) =>
            count + Number(values.delete(key) || hashes.delete(key)),
          0,
        ),
      ),
      expire: jest.fn().mockResolvedValue(1),
      hset: jest.fn(async (key: string, field: string, value: string) => {
        const hash = hashes.get(key) ?? new Map<string, string>();
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
      }),
      hsetnx: jest.fn(async (key: string, field: string, value: string) => {
        const hash = hashes.get(key) ?? new Map<string, string>();
        if (hash.has(field)) return 0;
        hash.set(field, value);
        hashes.set(key, hash);
        return 1;
      }),
      hget: jest.fn(async (key: string, field: string) =>
        hashes.get(key)?.get(field) ?? null,
      ),
      hdel: jest.fn(async (key: string, field: string) =>
        Number(hashes.get(key)?.delete(field) ?? false),
      ),
      sendCommand: jest.fn().mockResolvedValue([1]),
      hgetall: jest.fn(async (key: string) =>
        Object.fromEntries(hashes.get(key) ?? []),
      ),
      keys: jest.fn().mockResolvedValue([]),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(true),
      has: jest.fn().mockResolvedValue(false),
    };
    expiryQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
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

  it("hashes the phone capability, accepts a supported video signature, and reports the uploaded preview", async () => {
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
      "video/webm;codecs=vp8",
      10_000,
    );
    expect(uploaded).toEqual({ mediaId: expect.any(String) });
    await expect(service.getPhoneVideoDraft(session!.token)).resolves.toMatchObject({
      state: "ready",
    });
    await expect(
      service.uploadOwnedVideoDraft(
        session!.id,
        stranger,
        webm,
        "video/webm",
        10_000,
      ),
    ).resolves.toBeUndefined();
    expect(expiryQueue.add).not.toHaveBeenCalled();
    await expect(
      service.getVideoMediaForViewer(uploaded!.mediaId, owner),
    ).resolves.toBeUndefined();
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
        "text cannot accompany video",
        true,
        "browser-session",
        session!.id,
      ),
    ).resolves.toMatchObject({ accepted: false });
    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Global,
        "another-room",
        owner,
        "",
        true,
        "browser-session",
        session!.id,
      ),
    ).resolves.toMatchObject({ accepted: false });

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
    expect(hashes.get("chat_global_global")?.has(session!.id)).toBe(true);
    expect(expiryQueue.add).toHaveBeenCalledWith(
      "ExpireSentChatVideoMedia",
      {
        mediaId: expect.any(String),
        objectKey: expect.stringMatching(/^chat-video\/.+\.webm$/),
      },
      expect.objectContaining({ delay: 37 * 1000 + 60 * 60 * 1000 + 1000 }),
    );
    const mediaId = JSON.parse(
      hashes.get("chat_global_global")!.get(session!.id)!,
    ).media.id;
    expect(await service.getVideoMediaForViewer(mediaId, owner)).toBeDefined();
    hashes.get("chat_global_global")!.delete(session!.id);
    await expect(
      service.getVideoMediaForViewer(mediaId, owner),
    ).resolves.toBeUndefined();
  });

  it("sends once through the server-bound phone session and makes retries idempotent", async () => {
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
    jest.spyOn(service as any, "getCurrentUser").mockResolvedValue(owner);
    jest
      .spyOn(service, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false, expiresAt: null, permanent: false });
    const normalChatSend = jest.spyOn(service, "sendMessageToChat");
    jest.spyOn(service as any, "to").mockImplementation(() => undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);

    const results = await Promise.all([
      service.sendPhoneVideoDraft(session!.token),
      service.sendOwnedVideoDraft(session!.id, owner),
    ]);
    await expect(service.sendPhoneVideoDraft(session!.token)).resolves.toEqual({
      accepted: true,
    });

    expect(results).toEqual([{ accepted: true }, { accepted: true }]);
    expect(
      normalChatSend.mock.calls.every(
        (call) =>
          call[0] === ChatLobbyType.Global &&
          call[1] === "global" &&
          call[3] === "" &&
          call[4] === false &&
          call[5] === undefined &&
          call[6] === session!.id,
      ),
    ).toBe(true);
    const messages = [...(hashes.get("chat_global_global")?.values() ?? [])].map(
      (value) => JSON.parse(value),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: session!.id,
      message: "",
      from: { steam_id: owner.steam_id },
      media: { type: "video" },
    });
    expect(expiryQueue.add).toHaveBeenCalledTimes(1);
  });

  it("moves a sent video's access and cleanup lifetime with migrated chat history", async () => {
    await service.updateChatMessageTTL(37);
    jest
      .spyOn(service as any, "canSendDraftMessage")
      .mockResolvedValue(true);
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Draft,
      "draft-1",
      owner,
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
    jest.spyOn(service as any, "to").mockImplementation(() => undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);
    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Draft,
        "draft-1",
        owner,
        "",
        true,
        undefined,
        session!.id,
      ),
    ).resolves.toMatchObject({ accepted: true });

    const delayedJob = {
      getState: jest.fn().mockResolvedValue("delayed"),
      changeDelay: jest.fn().mockResolvedValue(undefined),
    };
    expiryQueue.getJob.mockResolvedValue(delayedJob);
    await service.migrateLobbyMessages(
      ChatLobbyType.Draft,
      "draft-1",
      ChatLobbyType.Match,
      "match-1",
    );

    const matchChatTtlSeconds = 7 * 24 * 60 * 60;
    expect(delayedJob.changeDelay).toHaveBeenCalledWith(
      matchChatTtlSeconds * 1000 + 60 * 60 * 1000 + 1000,
    );
    expect(redis.sendCommand.mock.calls.at(-1)?.[0].args).toEqual([
      "chat_match_match-1",
      String(matchChatTtlSeconds),
      "FIELDS",
      "1",
      session!.id,
    ]);
    expect(
      redis.set.mock.calls.some(
        ([key, , ...args]: [string, ...any[]]) =>
          key === `chat_video_media:${uploaded!.mediaId}` &&
          args.includes("EX") &&
          args.includes(matchChatTtlSeconds),
      ),
    ).toBe(true);
    expect(hashes.get("chat_match_match-1")?.has(session!.id)).toBe(true);
    const media = JSON.parse(values.get(`chat_video_media:${uploaded!.mediaId}`)!);
    expect(media).toMatchObject({
      chatType: ChatLobbyType.Match,
      roomId: "match-1",
    });
    await expect(
      service.getVideoMediaForViewer(uploaded!.mediaId, owner),
    ).resolves.toBeDefined();
  });

  it("does not let cancel delete a video while final send is in progress", async () => {
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
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
    const draftKey = `chat_video_draft:${session!.id}`;
    const draft = JSON.parse(values.get(draftKey)!);
    draft.state = "sending";
    values.set(draftKey, JSON.stringify(draft));

    await expect(service.cancelPhoneVideoDraft(session!.token)).resolves.toBeUndefined();
    expect(s3.remove).not.toHaveBeenCalled();
    expect(values.has(`chat_video_media:${uploaded!.mediaId}`)).toBe(true);
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

  it("accepts MP4 content with the ISO BMFF ftyp signature", async () => {
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
    );
    const mp4 = Buffer.alloc(16);
    mp4.write("ftyp", 4, 4, "ascii");

    const uploaded = await service.uploadPhoneVideoDraft(
      session!.token,
      mp4,
      "video/mp4",
      1_000,
    );

    expect(uploaded).toEqual({ mediaId: expect.any(String) });
    expect(s3.put).toHaveBeenCalledWith(
      expect.stringMatching(/^chat-video\/.+\.mp4$/),
      mp4,
      "video/mp4",
    );
  });

  it("rejects an expired phone token before S3", async () => {
    const webm = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(256),
    ]);

    await expect(
      service.uploadPhoneVideoDraft("X".repeat(43), webm, "video/webm", 1_000),
    ).resolves.toBeUndefined();
    expect(s3.put).not.toHaveBeenCalled();
  });

  it("rejects a PC upload from the wrong session owner before S3", async () => {
    const session = await service.createVideoDraftSession(
      ChatLobbyType.Global,
      "global",
      owner,
    );
    const webm = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(256),
    ]);

    await expect(
      service.uploadOwnedVideoDraft(
        session!.id,
        stranger,
        webm,
        "video/webm",
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(s3.put).not.toHaveBeenCalled();
  });
});
