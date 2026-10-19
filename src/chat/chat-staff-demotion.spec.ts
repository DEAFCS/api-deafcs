import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// DEAFCS Security Batch 2: Match Chat, a finished match's Team Chat and Draft
// rooms are open to staff because of their role, and were only checked when
// joining. A staff member demoted while a tab sat in one kept receiving it.
// Whoever joins as staff is now re-read on every delivery; nobody else is.
describe("ChatService staff demotion", () => {
  const MATCH = "33333333-3333-4333-8333-333333333333";
  const LINEUP_1 = "44444444-4444-4444-8444-444444444441";
  const DRAFT = "55555555-5555-4555-8555-555555555555";
  const PLAYER = "76561190000000101";
  const PLAYER_ADMIN = "76561190000000102";
  const MODERATOR = "76561190000000201";
  const MATCH_ORGANIZER = "76561190000000202";

  let ROLES: Record<string, string>;
  let status: string;
  let sets: Map<string, Set<string>>;
  let service: ChatService;
  let hasura: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;

  const lineupPlayers = [PLAYER, PLAYER_ADMIN];

  beforeEach(() => {
    ROLES = {
      [PLAYER]: "user",
      [PLAYER_ADMIN]: "administrator",
      [MODERATOR]: "moderator",
      [MATCH_ORGANIZER]: "match_organizer",
    };
    status = "Live";
    sets = new Map();
    hasura = {
      query: jest.fn(async (query: any, steamId: string) => {
        if (query.matches_by_pk) {
          const id = String(steamId);
          return {
            matches_by_pk: {
              is_in_lineup: lineupPlayers.includes(id),
              is_coach: false,
              // is_match_organizer.sql: administrators and match organizers
              // organize every match, read with the caller's current role.
              is_organizer: ["administrator", "match_organizer"].includes(
                ROLES[id],
              ),
              status,
            },
          };
        }
        if (query.match_lineups_by_pk) {
          return {
            match_lineups_by_pk: {
              id: LINEUP_1,
              match_id: MATCH,
              coach_steam_id: null,
              is_on_lineup: lineupPlayers.includes(String(steamId)),
              match: { status },
            },
          };
        }
        if (query.draft_games) {
          return { draft_games: [] };
        }
        if (query.players) {
          const ids: string[] = query.players.__args.where.steam_id._in;
          return {
            players: ids.map((id) => ({ steam_id: id, role: ROLES[id] })),
          };
        }
        if (query.players_by_pk) {
          const id = String(query.players_by_pk.__args.steam_id);
          return { players_by_pk: { steam_id: id, role: ROLES[id] } };
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
      hpexpire: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
      hgetall: jest.fn().mockResolvedValue({}),
      sismember: jest.fn().mockResolvedValue(1),
      sadd: jest.fn(async (key: string, member: string) => {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key)!.add(member);
        return 1;
      }),
      srem: jest.fn(async (key: string, member: string) =>
        sets.get(key)?.delete(member) ? 1 : 0,
      ),
      smembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
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
      .spyOn(service as any, "addUserToLobby")
      .mockResolvedValue({ user: {}, inGame: false });
    jest.spyOn(service as any, "addSession").mockResolvedValue([1, 2]);
    jest
      .spyOn(service as any, "getDeletedMessageIds")
      .mockResolvedValue(new Set());
    jest
      .spyOn(service as any, "addReactionStateToMessages")
      .mockImplementation(async (messages: any) => messages);
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
    jest.spyOn(service as any, "removeUserData").mockResolvedValue(undefined);
  });

  const client = (steamId: string) =>
    ({
      id: `client-${steamId}`,
      user: { steam_id: steamId, name: "P", role: ROLES[steamId] },
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  async function join(type: ChatLobbyType, id: string, steamIds: string[]) {
    jest.spyOn(service as any, "getAllUsersInLobby").mockResolvedValue([]);
    for (const steamId of steamIds) {
      await service.joinMatchLobby(client(steamId), type, id);
    }
    jest
      .spyOn(service as any, "getAllUsersInLobby")
      .mockResolvedValue(steamIds.map((steamId) => ({ steamId })));
  }

  const recipients = () =>
    redis.publish.mock.calls
      .filter(([channel]) => channel === "send-message-to-steam-id")
      .map(([, message]) => JSON.parse(message).steamId);

  it("stops a demoted moderator's open tab receiving Match Chat", async () => {
    await join(ChatLobbyType.Match, MATCH, [PLAYER, MODERATOR]);

    ROLES[MODERATOR] = "user";
    await service.to(ChatLobbyType.Match, MATCH, "chat", { message: "gg" });

    expect(recipients()).toEqual([PLAYER]);
    expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(MODERATOR));
  });

  it("keeps delivering to a moderator who is still a moderator", async () => {
    await join(ChatLobbyType.Match, MATCH, [PLAYER, MODERATOR]);

    await service.to(ChatLobbyType.Match, MATCH, "chat", { message: "gg" });

    expect(recipients().sort()).toEqual([MODERATOR, PLAYER].sort());
  });

  it("keeps a demoted administrator who also plays in the match", async () => {
    await join(ChatLobbyType.Match, MATCH, [PLAYER, PLAYER_ADMIN]);

    ROLES[PLAYER_ADMIN] = "user";
    await service.to(ChatLobbyType.Match, MATCH, "chat", { message: "gg" });

    expect(recipients().sort()).toEqual([PLAYER, PLAYER_ADMIN].sort());
  });

  it("never re-reads players who did not join as staff", async () => {
    await join(ChatLobbyType.Match, MATCH, [PLAYER]);
    hasura.query.mockClear();

    await service.to(ChatLobbyType.Match, MATCH, "chat", { message: "gg" });

    expect(recipients()).toEqual([PLAYER]);
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("stops a demoted moderator reading a finished match's Team Chat", async () => {
    status = "Finished";
    const room = `${MATCH}:${LINEUP_1}`;
    await join(ChatLobbyType.MatchTeam, room, [PLAYER, MODERATOR]);

    ROLES[MODERATOR] = "verified_user";
    await service.to(ChatLobbyType.MatchTeam, room, "chat", { message: "gg" });

    expect(recipients()).toEqual([PLAYER]);
  });

  it("stops a demoted match organizer receiving a Draft room", async () => {
    await join(ChatLobbyType.Draft, DRAFT, [MATCH_ORGANIZER]);

    ROLES[MATCH_ORGANIZER] = "streamer";
    await service.to(ChatLobbyType.Draft, DRAFT, "chat", { message: "hi" });

    expect(recipients()).toEqual([]);
  });

  it("delivers to everyone when the roles cannot be read", async () => {
    await join(ChatLobbyType.Match, MATCH, [PLAYER, MODERATOR]);
    ROLES[MODERATOR] = "user";
    redis.smembers.mockRejectedValueOnce(new Error("redis is busy"));

    await service.to(ChatLobbyType.Match, MATCH, "chat", { message: "gg" });

    expect(recipients().sort()).toEqual([MODERATOR, PLAYER].sort());
  });
});
