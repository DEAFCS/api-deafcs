import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { ExpireChatAttachmentJobName } from "./enums/ChatVideoQueues";
import { ExpireSentChatVideoMedia } from "./jobs/ExpireSentChatVideoMedia";

// Approved retention: Organizer Chat 90 days, Team Chat 30 days. Every other
// room keeps the rule it had.
describe("chat message retention", () => {
  const DAY = 60 * 60 * 24;
  const TEAM = "11111111-1111-4111-8111-111111111111";
  const player = {
    steam_id: "76561190000000001",
    name: "Player",
    role: "administrator",
  } as any;

  let service: ChatService;
  let redis: Record<string, jest.Mock>;
  let postgres: { query: jest.Mock };
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let s3: { remove: jest.Mock; has: jest.Mock };

  beforeEach(() => {
    redis = {
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      hset: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
    };
    postgres = { query: jest.fn().mockResolvedValue([{ allowed: true }]) };
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    s3 = {
      remove: jest.fn().mockResolvedValue(true),
      has: jest.fn().mockResolvedValue(false),
    };
    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      { query: jest.fn().mockResolvedValue({}) } as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        hasBlocked: jest.fn().mockResolvedValue(false),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
      s3 as any,
      queue as any,
    );
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
  });

  const ttlOf = (type: ChatLobbyType) =>
    (service as any).getChatMessageTtlSeconds(type);

  describe("per-room TTL", () => {
    it("keeps Organizer messages for 90 days and Team messages for 30", () => {
      expect(ChatService.ORGANIZER_CHAT_TTL_SECONDS).toBe(90 * DAY);
      expect(ChatService.TEAM_CHAT_TTL_SECONDS).toBe(30 * DAY);
      expect(ttlOf(ChatLobbyType.Organizer)).toBe(90 * DAY);
      expect(ttlOf(ChatLobbyType.Team)).toBe(30 * DAY);
    });

    it("leaves every other room on its existing rule", () => {
      for (const type of [
        ChatLobbyType.Global,
        ChatLobbyType.Tournament,
        ChatLobbyType.Direct,
        ChatLobbyType.Draft,
        ChatLobbyType.MatchMaking,
      ])
        expect(ttlOf(type)).toBe(DAY);
      expect(ttlOf(ChatLobbyType.Match)).toBe(7 * DAY);
      expect(ttlOf(ChatLobbyType.MatchTeam)).toBe(7 * DAY);
    });

    it("does not follow the global chat_message_ttl setting for these two rooms", async () => {
      await service.updateChatMessageTTL(3 * DAY);
      expect(ttlOf(ChatLobbyType.Global)).toBe(3 * DAY);
      expect(ttlOf(ChatLobbyType.Organizer)).toBe(90 * DAY);
      expect(ttlOf(ChatLobbyType.Team)).toBe(30 * DAY);
    });
  });

  describe("stored messages", () => {
    const send = (type: ChatLobbyType, id: string, extra: any[] = []) =>
      service.sendMessageToChat(
        type,
        id,
        player,
        "gg",
        true,
        "tab-1",
        ...(extra as [any]),
      );
    const expiry = () =>
      redis.sendCommand.mock.calls
        .map(([command]) => command)
        .filter((command) => String(command.name).toLowerCase() === "hexpire")
        .map((command) => Number(command.args[1]));

    it.each([
      [ChatLobbyType.Organizer, "organizers", 90 * DAY],
      [ChatLobbyType.Team, TEAM, 30 * DAY],
      [ChatLobbyType.Global, "global", DAY],
      [ChatLobbyType.Tournament, "t1", DAY],
    ])("sets the field expiry of a %s message", async (type, id, seconds) => {
      await expect(send(type, id)).resolves.toEqual({ accepted: true });
      expect(expiry()).toEqual([seconds]);
    });

    it("hands the Team TTL to the sign-language video it consumes", async () => {
      redis.get.mockImplementation(async (key: string) =>
        key.startsWith("chat_video_draft:")
          ? JSON.stringify({
              ownerSteamId: player.steam_id,
              type: ChatLobbyType.Team,
              roomId: TEAM,
              state: "ready",
            })
          : null,
      );
      jest
        .spyOn(service as any, "findSentVideoMessage")
        .mockResolvedValue(undefined);
      const consume = jest
        .spyOn(service as any, "consumeVideoDraft")
        .mockResolvedValue({ alreadySent: true });

      await service.sendMessageToChat(
        ChatLobbyType.Team,
        TEAM,
        player,
        "",
        true,
        "tab-1",
        undefined,
        "website",
        undefined,
        "draft-1",
      );

      expect(consume.mock.calls[0][4]).toBe(30 * DAY);
    });
  });

  describe("attachments", () => {
    const upload = `chat-attachments/${player.steam_id}/0123456789abcdef.png`;
    const sendAttachment = (type: ChatLobbyType, id: string, url = upload) =>
      service.sendMessageToChat(
        type,
        id,
        player,
        "",
        true,
        "tab-1",
        { url, contentType: "image/png" },
      );

    it("keeps the attachment record for as long as its message", async () => {
      await sendAttachment(ChatLobbyType.Team, TEAM);
      const record = redis.set.mock.calls.find(([key]) =>
        String(key).startsWith("chat_attachment:"),
      );
      expect(record?.slice(2)).toEqual(["EX", 30 * DAY]);
    });

    it.each([
      [ChatLobbyType.Team, TEAM, 30 * DAY],
      [ChatLobbyType.Organizer, "organizers", 90 * DAY],
    ])(
      "schedules removal of the stored file after a %s message expires",
      async (type, id, seconds) => {
        await sendAttachment(type, id);
        expect(queue.add).toHaveBeenCalledTimes(1);
        const [name, data, options] = queue.add.mock.calls[0];
        expect(name).toBe(ExpireChatAttachmentJobName);
        expect(data).toMatchObject({ objectKey: upload });
        expect(options.delay).toBe(seconds * 1000 + 3_600_000 + 1000);
      },
    );

    it("leaves other rooms' attachments exactly as before (no job)", async () => {
      await sendAttachment(ChatLobbyType.Global, "global");
      await sendAttachment(ChatLobbyType.Tournament, "t1");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([
      "chat-attachments/76561190000000002/0123456789abcdef.png",
      "chat-video/11111111-1111-4111-8111-111111111111.mp4",
      "demos/some-match.dem",
      "chat-attachments/76561190000000001/../../demos/x.png",
      "chat-attachments/76561190000000001/nothex.png",
    ])("refuses a message pointing at %s", async (url) => {
      await expect(
        sendAttachment(ChatLobbyType.Team, TEAM, url),
      ).resolves.toEqual({ accepted: false });
      expect(redis.hset).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("an upload can only be attached to one message, so no other message can lose its file", async () => {
      const claims = new Map<string, string>();
      redis.set.mockImplementation(async (key: string, value: string, ...rest: any[]) => {
        if (rest.includes("NX") && claims.has(key)) return null;
        if (rest.includes("NX")) claims.set(key, value);
        return "OK";
      });
      await expect(sendAttachment(ChatLobbyType.Team, TEAM)).resolves.toEqual({
        accepted: true,
      });
      // The same upload again: same room, another room, or a room with no cleanup.
      for (const [type, id] of [
        [ChatLobbyType.Team, TEAM],
        [ChatLobbyType.Organizer, "organizers"],
        [ChatLobbyType.Global, "global"],
      ] as const)
        await expect(sendAttachment(type, id)).resolves.toEqual({
          accepted: false,
        });
      expect(redis.hset).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("claims the upload for the long term, past the longest retention and cleanup delay", async () => {
      await sendAttachment(ChatLobbyType.Team, TEAM);
      const claim = redis.set.mock.calls.find(([key]) =>
        String(key).startsWith("chat_attachment_claim:"),
      );
      expect(claim?.slice(2)).toEqual(["EX", 120 * DAY, "NX"]);
      expect(120 * DAY).toBeGreaterThan(90 * DAY + 3600);
    });

    it("cleanup leaves the file alone unless this attachment's message claimed it", async () => {
      for (const claimed of [null, "ffffffffffffffff"]) {
        redis.get.mockResolvedValue(claimed);
        await service.cleanupExpiredChatAttachment("0123456789abcdef", upload);
      }
      expect(s3.remove).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it("removes the file and the record when the job runs, and only for a real upload path", async () => {
      redis.get.mockResolvedValue("0123456789abcdef");
      await service.cleanupExpiredChatAttachment("0123456789abcdef", upload);
      expect(s3.remove).toHaveBeenCalledWith(upload);
      expect(redis.del).toHaveBeenCalledWith("chat_attachment:0123456789abcdef");

      for (const [id, key] of [
        ["0123456789abcdef", "demos/x.dem"],
        ["zz", upload],
      ]) {
        await expect(
          service.cleanupExpiredChatAttachment(id, key),
        ).rejects.toThrow("invalid chat attachment cleanup target");
      }
      expect(s3.remove).toHaveBeenCalledTimes(1);
    });

    it("retries (throws) while the file is still in storage", async () => {
      redis.get.mockResolvedValue("0123456789abcdef");
      s3.remove.mockResolvedValue(false);
      s3.has.mockResolvedValue(true);
      await expect(
        service.cleanupExpiredChatAttachment("0123456789abcdef", upload),
      ).rejects.toThrow("unable to remove expired chat attachment");
    });

    it("the queue worker routes attachment jobs to the attachment cleanup", async () => {
      const chat = {
        cleanupExpiredChatAttachment: jest.fn(),
        cleanupExpiredSentVideoMedia: jest.fn(),
      };
      const worker = new ExpireSentChatVideoMedia(chat as any);
      await worker.process({
        name: ExpireChatAttachmentJobName,
        data: { attachmentId: "0123456789abcdef", objectKey: upload },
      } as any);
      expect(chat.cleanupExpiredChatAttachment).toHaveBeenCalledWith(
        "0123456789abcdef",
        upload,
      );
      expect(chat.cleanupExpiredSentVideoMedia).not.toHaveBeenCalled();

      await worker.process({
        name: "ExpireSentChatVideoMedia",
        data: { mediaId: "m", objectKey: "chat-video/m.mp4" },
      } as any);
      expect(chat.cleanupExpiredSentVideoMedia).toHaveBeenCalledWith(
        "m",
        "chat-video/m.mp4",
      );
    });
  });
});
