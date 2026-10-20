import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// Global is open to verified_user and above and has no roster, so it was only
// checked when joining. A player whose Verified status was removed while a tab
// sat in Global kept receiving (and sending to) it until they left.
describe("ChatService Global after Verified is removed", () => {
  const GLOBAL = "global";
  const VERIFIED = "76561190000000301";
  const REVOKED = "76561190000000302";
  const ADMIN = "76561190000000303";

  let ROLES: Record<string, string>;
  let service: ChatService;
  let hasura: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;

  beforeEach(() => {
    ROLES = {
      [VERIFIED]: "verified_user",
      [REVOKED]: "verified_user",
      [ADMIN]: "administrator",
    };
    hasura = {
      query: jest.fn(async (query: any) => {
        if (query.players) {
          const ids: string[] = query.players.__args.where.steam_id._in;
          return {
            players: ids.map((id) => ({ steam_id: id, role: ROLES[id] })),
          };
        }
        if (query.players_by_pk) {
          const id = String(query.players_by_pk.__args.steam_id);
          return ROLES[id]
            ? { players_by_pk: { steam_id: id, role: ROLES[id], name: "P" } }
            : { players_by_pk: null };
        }
        return {};
      }),
    };
    redis = {
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      hget: jest.fn().mockResolvedValue(null),
      hset: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      sismember: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
    };
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );

    jest
      .spyOn(service as any, "getAllUsersInLobby")
      .mockResolvedValue(
        [VERIFIED, REVOKED, ADMIN].map((steamId) => ({ steamId })),
      );
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
    jest.spyOn(service as any, "removeUserData").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: {}, inGame: false });
  });

  const recipients = () =>
    redis.publish.mock.calls
      .filter(([channel]) => channel === "send-message-to-steam-id")
      .map(([, message]) => JSON.parse(message).steamId)
      .sort();

  // The socket's user, as it was when the tab joined.
  const socketUser = (steamId: string) =>
    ({ steam_id: steamId, name: "P", role: "verified_user" }) as any;

  it("stops delivering Global to a player whose Verified was removed", async () => {
    ROLES[REVOKED] = "user";

    await service.to(ChatLobbyType.Global, GLOBAL, "chat", { message: "hi" });

    expect(recipients()).toEqual([ADMIN, VERIFIED].sort());
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(REVOKED));
  });

  it("keeps delivering to every verified player and staff", async () => {
    await service.to(ChatLobbyType.Global, GLOBAL, "chat", { message: "hi" });

    expect(recipients()).toEqual([ADMIN, REVOKED, VERIFIED].sort());
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("delivers to everyone when the roles cannot be read", async () => {
    ROLES[REVOKED] = "user";
    hasura.query.mockRejectedValueOnce(new Error("hasura is busy"));

    await service.to(ChatLobbyType.Global, GLOBAL, "chat", { message: "hi" });

    expect(recipients()).toEqual([ADMIN, REVOKED, VERIFIED].sort());
  });

  it("re-reads the role for Global access, not the socket's old one", async () => {
    ROLES[REVOKED] = "user";

    await expect(
      (service as any).hasLobbyPermission(
        ChatLobbyType.Global,
        GLOBAL,
        socketUser(REVOKED),
      ),
    ).resolves.toBe(false);
    await expect(
      (service as any).hasLobbyPermission(
        ChatLobbyType.Global,
        GLOBAL,
        socketUser(VERIFIED),
      ),
    ).resolves.toBe(true);
  });

  it("refuses a Global message from a player whose Verified was removed", async () => {
    ROLES[REVOKED] = "user";

    const result = await service.sendMessageToChat(
      ChatLobbyType.Global,
      GLOBAL,
      socketUser(REVOKED),
      "still here?",
    );

    expect(result).toEqual({ accepted: false });
    expect(recipients()).toEqual([]);
  });
});
