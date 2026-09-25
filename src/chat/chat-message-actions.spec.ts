import {
  CHAT_MESSAGE_EDIT_MAX_LENGTH,
  CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS,
  ChatService,
} from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { ChatGateway } from "./chat.gateway";
import { User } from "../auth/types/User";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const MINUTE = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const author: User = {
  steam_id: "76561190000000001",
  name: "Author",
  role: "verified_user",
};
const other: User = {
  steam_id: "76561190000000002",
  name: "Other",
  role: "verified_user",
};
const admin: User = {
  steam_id: "76561190000000003",
  name: "Admin",
  role: "administrator",
};
const otherAdmin: User = {
  steam_id: "76561190000000004",
  name: "Admin Two",
  role: "administrator",
};
const players = new Map(
  [author, other, admin, otherAdmin].map((user) => [user.steam_id, user]),
);

const messageId = "123e4567-e89b-42d3-a456-426614174000";
const announcementId = "223e4567-e89b-42d3-a456-426614174000";

function storedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: messageId,
    message: "original",
    timestamp: ago(2 * MINUTE),
    from: {
      steam_id: author.steam_id,
      name: author.name,
      role: author.role,
    },
    clientId: "client-1",
    source: "website",
    ...overrides,
  };
}

describe("ChatService timed self edit/delete", () => {
  let service: ChatService;
  let redis: Record<string, jest.Mock>;
  let postgres: { query: jest.Mock };
  let hasura: { query: jest.Mock };
  let blocks: Record<string, jest.Mock>;
  let restrictions: { getStatus: jest.Mock };
  let notifications: Record<string, jest.Mock>;
  let rcon: Record<string, jest.Mock>;
  let messages: Map<string, Map<string, string>>;
  let lobbyMembers: Set<string>;
  let mutedSteamIds: Set<string>;
  let deletedMessageIds: Set<string>;
  let announcementRows: Array<{
    id: string;
    author_steam_id: string;
    created_at: string;
    deleted_at: string | null;
    message: string;
  }>;
  let tournamentAccess: boolean;
  let friends: boolean;

  function put(type: ChatLobbyType, roomId: string, message: any) {
    const key = `chat_${type}_${roomId}`;
    if (!messages.has(key)) messages.set(key, new Map());
    messages.get(key)!.set(String(message.id), JSON.stringify(message));
    return JSON.stringify(message);
  }

  function client(user: User) {
    return { id: `socket-${user.steam_id}`, user: { ...user } } as any;
  }

  function join(user: User, type: ChatLobbyType, roomId: string) {
    lobbyMembers.add(`chat:${type}:${roomId}|${user.steam_id}`);
  }

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    messages = new Map();
    lobbyMembers = new Set();
    mutedSteamIds = new Set();
    deletedMessageIds = new Set();
    announcementRows = [];
    tournamentAccess = true;
    friends = true;

    redis = {
      hget: jest.fn(async (key: string, field: string) => {
        if (key.startsWith("chat:")) {
          return lobbyMembers.has(`${key}|${field}`)
            ? JSON.stringify({ user: players.get(field) })
            : null;
        }
        return messages.get(key)?.get(field) ?? null;
      }),
      sismember: jest.fn().mockResolvedValue(1),
      hdel: jest.fn(async (key: string, field: string) =>
        messages.get(key)?.delete(field) ? 1 : 0,
      ),
      del: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      publish: jest.fn().mockResolvedValue(1),
      eval: jest.fn(async (script: string, _keys: number, ...args: any[]) => {
        if (script.includes("HPEXPIRE")) {
          const [messageKey, , field, expected, next] = args;
          const current = messages.get(messageKey)?.get(field);
          if (current !== expected) return [0, -2];
          messages.get(messageKey)!.set(field, next);
          return [1, 5 * MINUTE];
        }
        return 1;
      }),
    };
    postgres = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes("player_sanctions")) {
          return mutedSteamIds.has(String(params[0]))
            ? [{ remove_sanction_date: null as string | null }]
            : [];
        }
        if (
          sql.includes("UPDATE public.announcements") &&
          sql.includes("SET message")
        ) {
          const [id, message, actorSteamId, cutoff] = params;
          const row = announcementRows.find(
            (candidate) =>
              candidate.id === id &&
              !candidate.deleted_at &&
              candidate.author_steam_id === String(actorSteamId) &&
              Date.parse(candidate.created_at) >= Date.parse(cutoff),
          );
          if (!row) return [];
          row.message = message;
          return [{ id }];
        }
        if (
          sql.includes("UPDATE public.announcements") &&
          sql.includes("deleted_at = now()")
        ) {
          const [id, actorSteamId, , isAdministrator, cutoff] = params;
          const row = announcementRows.find(
            (candidate) =>
              candidate.id === id &&
              !candidate.deleted_at &&
              (isAdministrator ||
                (candidate.author_steam_id === String(actorSteamId) &&
                  Date.parse(candidate.created_at) >= Date.parse(cutoff))),
          );
          if (!row) return [];
          row.deleted_at = new Date(NOW).toISOString();
          return [{ message_id: id }];
        }
        if (
          sql.includes("SELECT message_id") &&
          sql.includes("chat_message_deletions")
        ) {
          return [...deletedMessageIds].map((message_id) => ({ message_id }));
        }
        if (sql.includes("INSERT INTO public.chat_message_deletions")) {
          if (deletedMessageIds.has(params[0])) return [];
          deletedMessageIds.add(params[0]);
          return [{ message_id: params[0] }];
        }
        return [];
      }),
    };
    hasura = {
      query: jest.fn(async (query: Record<string, any>) => {
        if ("players_by_pk" in query) {
          return {
            players_by_pk:
              players.get(String(query.players_by_pk.__args.steam_id)) ?? null,
          };
        }
        if ("tournaments" in query) {
          return { tournaments: tournamentAccess ? [{ id: "t-1" }] : [] };
        }
        if ("friends" in query) {
          return {
            friends: friends ? [{ player_steam_id: author.steam_id }] : [],
          };
        }
        return {};
      }),
    };
    blocks = {
      isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
      hasBlocked: jest.fn().mockResolvedValue(false),
      getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
    };
    restrictions = {
      getStatus: jest.fn().mockResolvedValue({ active: false }),
    };
    notifications = {
      sendSilent: jest.fn(),
      notifyPlayers: jest.fn(),
      send: jest.fn(),
    };
    rcon = { connect: jest.fn() };

    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      rcon as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      notifications as any,
      blocks as any,
      restrictions as any,
      { put: jest.fn(), remove: jest.fn().mockResolvedValue(undefined) } as any,
      { add: jest.fn() } as any,
    );
    jest.spyOn(service, "to").mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function stored(type = ChatLobbyType.Global, roomId = "global") {
    const raw = messages.get(`chat_${type}_${roomId}`)?.get(messageId);
    return raw ? JSON.parse(raw) : undefined;
  }

  function expectNoMessageSideEffects() {
    expect(notifications.sendSilent).not.toHaveBeenCalled();
    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
    expect(rcon.connect).not.toHaveBeenCalled();
    const events = (service.to as jest.Mock).mock.calls.map((call) => call[2]);
    expect(events).not.toContain("chat");
  }

  describe("editChatMessage (Redis)", () => {
    async function edit(
      user: User,
      text = "fixed typo",
      type = ChatLobbyType.Global,
      roomId = "global",
    ) {
      return service.editChatMessage(
        client(user),
        type,
        roomId,
        messageId,
        text,
      );
    }

    it("lets the author edit their own recent text and preserves everything but the text", async () => {
      const original = storedMessage();
      const raw = put(ChatLobbyType.Global, "global", original);
      join(author, ChatLobbyType.Global, "global");

      await expect(edit(author, "  fixed typo  ")).resolves.toBe(true);

      expect(stored()).toEqual({ ...original, message: "fixed typo" });
      const [script, keyCount, messageKey, deletedKey, field, expected] =
        redis.eval.mock.calls[0];
      expect(keyCount).toBe(2);
      expect(messageKey).toBe("chat_global_global");
      expect(deletedKey).toBe(`chat:reaction:deleted:${messageId}`);
      expect(field).toBe(messageId);
      expect(expected).toBe(raw);
      expect(script).toContain("EXISTS");
      expect(service.to).toHaveBeenCalledWith(
        ChatLobbyType.Global,
        "global",
        "edited",
        { id: messageId, message: "fixed typo" },
        expect.any(Function),
      );
      expectNoMessageSideEffects();
    });

    it("preserves the remaining field TTL instead of restarting retention", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      await edit(author);

      const script: string = redis.eval.mock.calls[0][0];
      const hpttl = script.indexOf("HPTTL");
      const hset = script.indexOf("'HSET'");
      const hpexpire = script.indexOf("HPEXPIRE");
      // Remaining TTL is read before the overwrite and re-applied after it,
      // with the same ttlMs value, never a fresh HEXPIRE lifetime.
      expect(hpttl).toBeGreaterThan(-1);
      expect(hset).toBeGreaterThan(hpttl);
      expect(hpexpire).toBeGreaterThan(hset);
      expect(script).toMatch(
        /HPEXPIRE', KEYS\[1\], ttlMs, 'FIELDS', 1, ARGV\[1\]/,
      );
      expect(script).not.toMatch(/HEXPIRE'/);
      // A field that has already expired/vanished (-2) or has 0ms left is
      // never resurrected by an edit.
      expect(script).toMatch(/ttlMs == -2 or ttlMs == 0 then return \{0, -2\}/);
    });

    it("allows exactly 10 minutes and refuses one millisecond later", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ timestamp: ago(CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS) }),
      );
      join(author, ChatLobbyType.Global, "global");
      await expect(edit(author)).resolves.toBe(true);

      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({
          timestamp: ago(CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS + 1),
        }),
      );
      await expect(edit(author, "again")).resolves.toBe(false);
    });

    it("refuses the author after 10 minutes", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ timestamp: ago(11 * MINUTE) }),
      );
      join(author, ChatLobbyType.Global, "global");
      await expect(edit(author)).resolves.toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("refuses another player", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(other, ChatLobbyType.Global, "global");
      await expect(edit(other)).resolves.toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("gives administrators no edit override for someone else's message", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(admin, ChatLobbyType.Global, "global");
      await expect(edit(admin)).resolves.toBe(false);
      expect(stored().message).toBe("original");
    });

    it("lets an administrator edit their own message only inside the window", async () => {
      const adminFrom = {
        steam_id: admin.steam_id,
        name: admin.name,
        role: admin.role,
      };
      join(admin, ChatLobbyType.Global, "global");

      put(ChatLobbyType.Global, "global", storedMessage({ from: adminFrom }));
      await expect(edit(admin)).resolves.toBe(true);

      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ from: adminFrom, timestamp: ago(30 * MINUTE) }),
      );
      await expect(edit(admin, "late")).resolves.toBe(false);
    });

    it.each([
      [
        "a Short Video message",
        storedMessage({ message: "", media: { type: "video", id: "media-1" } }),
      ],
      ["a game-relayed (automatic) line", storedMessage({ source: "game" })],
      [
        "a message with no source (legacy/system)",
        storedMessage({ source: undefined }),
      ],
      [
        "a message without an author",
        storedMessage({ from: { name: "System" } }),
      ],
      [
        "a message without a valid timestamp",
        storedMessage({ timestamp: "not-a-date" }),
      ],
      [
        "a message with a mismatched id",
        storedMessage({ id: "some-other-id" }),
      ],
      ["a blocked/redacted message", storedMessage({ blocked: true })],
    ])("refuses to edit %s", async (_label, message) => {
      put(ChatLobbyType.Global, "global", message);
      if (String(message.id) !== messageId) {
        messages
          .get("chat_global_global")!
          .set(messageId, JSON.stringify(message));
      }
      join(author, ChatLobbyType.Global, "global");
      await expect(edit(author)).resolves.toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("refuses malformed stored JSON", async () => {
      messages.set("chat_global_global", new Map([[messageId, "{not json"]]));
      join(author, ChatLobbyType.Global, "global");
      await expect(edit(author)).resolves.toBe(false);
    });

    it("refuses an already-deleted message (audit marker)", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      deletedMessageIds.add(messageId);
      await expect(edit(author)).resolves.toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("refuses when the atomic compare-and-swap loses a race", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      redis.eval.mockResolvedValueOnce([0, -3]);
      await expect(edit(author)).resolves.toBe(false);
      expect(service.to).not.toHaveBeenCalled();
    });

    it("rejects blank and over-length edits", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      await expect(edit(author, "   ")).resolves.toBe(false);
      await expect(
        edit(author, "x".repeat(CHAT_MESSAGE_EDIT_MAX_LENGTH + 1)),
      ).resolves.toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
      await expect(
        edit(author, "x".repeat(CHAT_MESSAGE_EDIT_MAX_LENGTH)),
      ).resolves.toBe(true);
    });

    it("refuses a restricted author", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      restrictions.getStatus.mockResolvedValue({ active: true });
      await expect(edit(author)).resolves.toBe(false);
    });

    it("refuses a website-chat-muted author (editing would post new content)", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      mutedSteamIds.add(author.steam_id);
      await expect(edit(author)).resolves.toBe(false);
    });

    it("refuses a wrong room or the announcement type", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      await expect(
        edit(author, "x", ChatLobbyType.MatchMaking, "other-lobby"),
      ).resolves.toBe(false);
      await expect(
        edit(author, "x", ChatLobbyType.Announcement, "announcement"),
      ).resolves.toBe(false);
      await expect(
        edit(author, "x", "bogus" as ChatLobbyType, "global"),
      ).resolves.toBe(false);
    });

    it("refuses an author who is no longer in the room", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      await expect(edit(author)).resolves.toBe(false);
    });

    it("rechecks tournament access", async () => {
      put(ChatLobbyType.Tournament, "t-1", storedMessage());
      join(author, ChatLobbyType.Tournament, "t-1");
      tournamentAccess = false;
      await expect(
        edit(author, "x", ChatLobbyType.Tournament, "t-1"),
      ).resolves.toBe(false);
      tournamentAccess = true;
      await expect(
        edit(author, "x", ChatLobbyType.Tournament, "t-1"),
      ).resolves.toBe(true);
    });

    it("rechecks Direct friendship and blocking", async () => {
      const room = `${author.steam_id}:${other.steam_id}`;
      put(ChatLobbyType.Direct, room, storedMessage());
      join(author, ChatLobbyType.Direct, room);

      blocks.isBlockedEitherDirection.mockResolvedValueOnce(true);
      await expect(edit(author, "x", ChatLobbyType.Direct, room)).resolves.toBe(
        false,
      );

      friends = false;
      await expect(edit(author, "x", ChatLobbyType.Direct, room)).resolves.toBe(
        false,
      );

      friends = true;
      await expect(edit(author, "x", ChatLobbyType.Direct, room)).resolves.toBe(
        true,
      );
      expect(service.to).toHaveBeenLastCalledWith(
        ChatLobbyType.Direct,
        room,
        "edited",
        { id: messageId, message: "x" },
      );
    });

    it("redacts the edited text for viewers who blocked the author", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      await edit(author, "new text");

      const redact = (service.to as jest.Mock).mock.calls[0][4];
      blocks.hasBlocked.mockResolvedValueOnce(true);
      await expect(redact(other.steam_id)).resolves.toEqual({
        id: messageId,
        message: "Message from blocked player",
      });
      await expect(redact(author.steam_id)).resolves.toBeUndefined();
      blocks.hasBlocked.mockResolvedValueOnce(false);
      await expect(redact(other.steam_id)).resolves.toBeUndefined();
    });

    it("never relays a Match chat edit to the game server", async () => {
      jest
        .spyOn(service as any, "hasCurrentChatRoomAccess")
        .mockResolvedValue(true);
      put(ChatLobbyType.Match, "match-1", storedMessage());
      const sendChatToServer = jest.spyOn(service, "sendChatToServer");
      await expect(
        edit(author, "x", ChatLobbyType.Match, "match-1"),
      ).resolves.toBe(true);
      expect(sendChatToServer).not.toHaveBeenCalled();
      expectNoMessageSideEffects();
    });
  });

  describe("editAnnouncement", () => {
    function announcement(
      overrides: Partial<(typeof announcementRows)[number]> = {},
    ) {
      const row = {
        id: announcementId,
        author_steam_id: admin.steam_id,
        created_at: ago(2 * MINUTE),
        deleted_at: null as string | null,
        message: "announcement",
        ...overrides,
      };
      announcementRows.push(row);
      return row;
    }

    beforeEach(() => {
      join(admin, ChatLobbyType.Announcement, "announcement");
      join(otherAdmin, ChatLobbyType.Announcement, "announcement");
      join(author, ChatLobbyType.Announcement, "announcement");
    });

    it("lets the original administrator author edit within 10 minutes", async () => {
      const row = announcement();
      await expect(
        service.editAnnouncement(client(admin), announcementId, " updated "),
      ).resolves.toBe(true);
      expect(row.message).toBe("updated");
      const [sql, params] = postgres.query.mock.calls.find(([q]: [string]) =>
        q.includes("SET message"),
      );
      expect(sql).toContain("author_steam_id = $3::bigint");
      expect(sql).toContain("created_at >= $4::timestamptz");
      expect(params[3]).toBe(ago(CHAT_MESSAGE_SELF_SERVICE_WINDOW_MS));
      expect(service.to).toHaveBeenCalledWith(
        ChatLobbyType.Announcement,
        "announcement",
        "edited",
        { id: announcementId, message: "updated" },
      );
      expectNoMessageSideEffects();
    });

    it("does not let another administrator edit it", async () => {
      const row = announcement();
      await expect(
        service.editAnnouncement(client(otherAdmin), announcementId, "hijack"),
      ).resolves.toBe(false);
      expect(row.message).toBe("announcement");
      expect(service.to).not.toHaveBeenCalled();
    });

    it("does not let the author edit after 10 minutes", async () => {
      announcement({ created_at: ago(10 * MINUTE + 1) });
      await expect(
        service.editAnnouncement(client(admin), announcementId, "late"),
      ).resolves.toBe(false);
    });

    it("does not edit a deleted announcement", async () => {
      announcement({ deleted_at: ago(MINUTE) });
      await expect(
        service.editAnnouncement(client(admin), announcementId, "x"),
      ).resolves.toBe(false);
    });

    it("keeps announcement editing administrator-only, restriction- and mute-checked", async () => {
      announcement({ author_steam_id: author.steam_id });
      await expect(
        service.editAnnouncement(client(author), announcementId, "x"),
      ).resolves.toBe(false);

      announcement();
      restrictions.getStatus.mockResolvedValueOnce({ active: true });
      await expect(
        service.editAnnouncement(client(admin), announcementId, "x"),
      ).resolves.toBe(false);

      mutedSteamIds.add(admin.steam_id);
      await expect(
        service.editAnnouncement(client(admin), announcementId, "x"),
      ).resolves.toBe(false);
      expect(
        postgres.query.mock.calls.some(([q]: [string]) =>
          q.includes("SET message"),
        ),
      ).toBe(false);
    });
  });

  describe("deleteMessage", () => {
    async function remove(
      user: User,
      type = ChatLobbyType.Global,
      roomId = "global",
    ) {
      return service.deleteMessage(client(user), type, roomId, messageId);
    }

    function auditInsert() {
      return postgres.query.mock.calls.find(([q]: [string]) =>
        q.includes("INSERT INTO public.chat_message_deletions"),
      );
    }

    it("lets the author delete their own recent message, audited as self-deleted", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");

      await expect(remove(author)).resolves.toBe(true);

      const [, params] = auditInsert();
      expect(params).toEqual([
        messageId,
        ChatLobbyType.Global,
        "global",
        author.steam_id,
        "original",
        storedMessage().timestamp,
        author.steam_id,
      ]);
      expect(stored()).toBeUndefined();
      expect(service.to).toHaveBeenCalledWith(
        ChatLobbyType.Global,
        "global",
        "deleted",
        { id: messageId },
      );
      expectNoMessageSideEffects();
    });

    it("refuses the author after 10 minutes and leaves no audit", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ timestamp: ago(11 * MINUTE) }),
      );
      join(author, ChatLobbyType.Global, "global");
      await expect(remove(author)).resolves.toBe(false);
      expect(auditInsert()).toBeUndefined();
      expect(stored()).toBeDefined();
    });

    it("refuses an ordinary player deleting someone else's message", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(other, ChatLobbyType.Global, "global");
      await expect(remove(other)).resolves.toBe(false);
      expect(auditInsert()).toBeUndefined();
    });

    it("lets an administrator delete someone else's message at any age, audited as the admin", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ timestamp: ago(6 * 60 * MINUTE) }),
      );
      await expect(remove(admin)).resolves.toBe(true);
      expect(auditInsert()[1][3]).toBe(author.steam_id);
      expect(auditInsert()[1][6]).toBe(admin.steam_id);
    });

    it("lets an administrator delete their own old message (moderation authority)", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({
          from: { steam_id: admin.steam_id, name: admin.name },
          timestamp: ago(60 * MINUTE),
        }),
      );
      await expect(remove(admin)).resolves.toBe(true);
    });

    it("lets an administrator delete a game-relayed line (existing moderation reach)", async () => {
      put(ChatLobbyType.Match, "match-1", storedMessage({ source: "game" }));
      await expect(remove(admin, ChatLobbyType.Match, "match-1")).resolves.toBe(
        true,
      );
    });

    it("does not let an author self-delete a game-relayed line", async () => {
      jest
        .spyOn(service as any, "hasCurrentChatRoomAccess")
        .mockResolvedValue(true);
      put(ChatLobbyType.Match, "match-1", storedMessage({ source: "game" }));
      await expect(
        remove(author, ChatLobbyType.Match, "match-1"),
      ).resolves.toBe(false);
    });

    it("lets the author delete their own recent Short Video and cleans its media", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ message: "", media: { type: "video", id: "media-1" } }),
      );
      join(author, ChatLobbyType.Global, "global");
      const removeVideoMedia = jest
        .spyOn(service, "removeVideoMedia")
        .mockResolvedValue(undefined);

      await expect(remove(author)).resolves.toBe(true);
      expect(removeVideoMedia).toHaveBeenCalledWith("media-1");
    });

    it("does not let an ordinary player delete someone else's Short Video", async () => {
      put(
        ChatLobbyType.Global,
        "global",
        storedMessage({ message: "", media: { type: "video", id: "media-1" } }),
      );
      join(other, ChatLobbyType.Global, "global");
      const removeVideoMedia = jest.spyOn(service, "removeVideoMedia");
      await expect(remove(other)).resolves.toBe(false);
      expect(removeVideoMedia).not.toHaveBeenCalled();
    });

    it("allows a muted author to delete their own recent message (removal posts nothing new)", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      mutedSteamIds.add(author.steam_id);
      await expect(remove(author)).resolves.toBe(true);
    });

    it("refuses a restricted author or administrator", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      restrictions.getStatus.mockResolvedValue({ active: true });
      await expect(remove(author)).resolves.toBe(false);
      await expect(remove(admin)).resolves.toBe(false);
    });

    it("requires the author to still have room access (Direct block)", async () => {
      const room = `${author.steam_id}:${other.steam_id}`;
      put(ChatLobbyType.Direct, room, storedMessage());
      join(author, ChatLobbyType.Direct, room);
      blocks.isBlockedEitherDirection.mockResolvedValue(true);
      await expect(remove(author, ChatLobbyType.Direct, room)).resolves.toBe(
        false,
      );
    });

    it("a deleted message can no longer be reacted to or edited", async () => {
      put(ChatLobbyType.Global, "global", storedMessage());
      join(author, ChatLobbyType.Global, "global");
      await expect(remove(author)).resolves.toBe(true);

      // The reaction-deleted marker is written for the message.
      expect(
        redis.eval.mock.calls.some((call) =>
          call.includes(`chat:reaction:deleted:${messageId}`),
        ),
      ).toBe(true);

      await expect(
        service.toggleChatMessageReaction(
          client(author),
          ChatLobbyType.Global,
          "global",
          messageId,
          "heart",
        ),
      ).resolves.toBe(false);
      await expect(
        service.editChatMessage(
          client(author),
          ChatLobbyType.Global,
          "global",
          messageId,
          "after delete",
        ),
      ).resolves.toBe(false);
    });

    describe("announcements", () => {
      beforeEach(() => {
        join(author, ChatLobbyType.Announcement, "announcement");
        announcementRows.push({
          id: announcementId,
          author_steam_id: admin.steam_id,
          created_at: ago(3 * 60 * MINUTE),
          deleted_at: null,
          message: "old",
        });
      });

      it("lets any administrator moderation-delete another admin's old announcement", async () => {
        await expect(
          service.deleteMessage(
            client(otherAdmin),
            ChatLobbyType.Announcement,
            "announcement",
            announcementId,
          ),
        ).resolves.toBe(true);
        const [sql, params] = postgres.query.mock.calls.find(([q]: [string]) =>
          q.includes("deleted_at = now()"),
        );
        expect(sql).toContain("chat_message_deletions");
        expect(params[1]).toBe(otherAdmin.steam_id);
        expect(params[3]).toBe(true);
      });

      it("refuses a non-administrator", async () => {
        await expect(
          service.deleteMessage(
            client(author),
            ChatLobbyType.Announcement,
            "announcement",
            announcementId,
          ),
        ).resolves.toBe(false);
        expect(announcementRows[0].deleted_at).toBeNull();
      });
    });
  });

  describe("ChatGateway lobby:chat:edit routing", () => {
    it("routes typed payloads to Redis edits and untyped ones to announcements, never to the game server", async () => {
      const chat = {
        editAnnouncement: jest.fn(),
        editChatMessage: jest.fn(),
        sendChatToServer: jest.fn(),
      };
      const gateway = new ChatGateway(chat as any);
      const socket = client(author);

      await gateway.editMessage({ id: announcementId, message: "a" }, socket);
      await gateway.editMessage(
        {
          id: messageId,
          message: "b",
          type: ChatLobbyType.Match,
          roomId: "match-1",
        },
        socket,
      );
      await gateway.editMessage(
        { id: messageId, message: "c", type: ChatLobbyType.Global },
        socket,
      );

      expect(chat.editAnnouncement).toHaveBeenCalledWith(
        socket,
        announcementId,
        "a",
      );
      expect(chat.editChatMessage).toHaveBeenCalledTimes(1);
      expect(chat.editChatMessage).toHaveBeenCalledWith(
        socket,
        ChatLobbyType.Match,
        "match-1",
        messageId,
        "b",
      );
      expect(chat.sendChatToServer).not.toHaveBeenCalled();
    });
  });
});
