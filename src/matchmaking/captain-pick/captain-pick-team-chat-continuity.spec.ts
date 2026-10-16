import { Logger } from "@nestjs/common";
import { ChatService } from "../../chat/chat.service";
import { ChatModule } from "../../chat/chat.module";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import { getCaptainPickDraftCacheKey } from "../utilities/cacheKeys";
import { CaptainPickService } from "./captain-pick.service";
import { canAccessCaptainPickTeamChat } from "./captain-pick-team-chat";
import { MatchMaking } from "../matchmaking.module";

// deafcs-web#124: Team Chat written while players were being picked must
// still be there once the match exists. The draft's private team rooms close
// at MatchCreated and their history moves into each side's own match Team
// Chat. Real ChatService and CaptainPickService over an in-memory Redis.
const DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const DRAFT_KEY = getCaptainPickDraftCacheKey(DRAFT_ID);
const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const LINEUP_1 = "66666666-6666-4666-8666-666666666661";
const LINEUP_2 = "66666666-6666-4666-8666-666666666662";
const teamA = `${DRAFT_ID}:1`;
const teamB = `${DRAFT_ID}:2`;
const matchTeamA = `${MATCH_ID}:${LINEUP_1}`;
const matchTeamB = `${MATCH_ID}:${LINEUP_2}`;

// Side 1: captain "2" and "5". Side 2: captain "1" and "6".
const draftState = (phase: string) =>
  JSON.stringify({
    phase,
    matchId: MATCH_ID,
    draft: { lineups: { 1: ["2", "5"], 2: ["1", "6"] } },
  });

const player = (steamId: string): User =>
  ({ steam_id: steamId, name: `P${steamId}`, role: "verified_user" }) as User;

function memoryRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  };
  const redis: Record<string, any> = {
    hashes,
    hget: jest.fn(async (key: string, field: string) => {
      const value = hashes.get(key)?.get(field);
      if (value !== undefined) return value;
      // Lobby membership lookups: every sender has "joined" some room.
      return key === DRAFT_KEY ? null : JSON.stringify({ user: {} });
    }),
    hgetall: jest.fn(async (key: string) =>
      Object.fromEntries(hashes.get(key) ?? new Map()),
    ),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      hash(key).set(field, value);
      return 1;
    }),
    hdel: jest.fn(async (key: string, field: string) =>
      hashes.get(key)?.delete(field) ? 1 : 0,
    ),
    del: jest.fn(async (...keys: string[]) => {
      keys.forEach((key) => hashes.delete(key));
      return keys.length;
    }),
    keys: jest.fn(async (): Promise<string[]> => []),
    expire: jest.fn(async () => 1),
    eval: jest.fn(async (script: string) =>
      script.includes("INCR") ? 1 : [1, 1],
    ),
    get: jest.fn(async (): Promise<string | null> => null),
    set: jest.fn(async () => "OK"),
    publish: jest.fn(async () => 1),
    sendCommand: jest.fn(async () => 1),
    pipeline: () => ({
      expire: jest.fn(),
      exec: jest.fn(async (): Promise<unknown[]> => []),
    }),
  };
  return redis;
}

describe("Captain Pick Team Chat carries into the match", () => {
  let redis: ReturnType<typeof memoryRedis>;
  let hasura: { query: jest.Mock };
  let chat: ChatService;
  let captainPick: CaptainPickService;

  beforeEach(() => {
    redis = memoryRedis();
    redis.hashes.set(
      DRAFT_KEY,
      new Map([["state", draftState("CreatingMatch")]]),
    );
    hasura = { query: jest.fn() };
    chat = new ChatService(
      { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      { notifyPlayers: jest.fn(), sendSilent: jest.fn() } as any,
      {
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
        hasBlocked: jest.fn().mockResolvedValue(false),
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
    jest.spyOn(chat, "to").mockResolvedValue(undefined);
    jest.spyOn(chat as any, "notifyLobbyMembers").mockResolvedValue(undefined);

    captainPick = new CaptainPickService(
      new Logger("CaptainPickTeamChatContinuity"),
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
      chat,
    );
  });

  const post = (steamId: string, room: string, message: string) =>
    chat.sendMessageToChat(
      ChatLobbyType.CaptainPickTeam,
      room,
      player(steamId),
      message,
    );

  const stored = (type: ChatLobbyType, id: string) =>
    [...(redis.hashes.get(`chat_${type}_${id}`)?.values() ?? [])]
      .map((value) => JSON.parse(value).message)
      .sort();

  // The match is created: the phase changes first, then the history moves.
  const createMatch = async () => {
    redis.hashes.get(DRAFT_KEY)!.set("state", draftState("MatchCreated"));
    await (captainPick as any).carryOverTeamChat(DRAFT_ID, {
      id: MATCH_ID,
      status: "Live",
      lineupIds: { 1: LINEUP_1, 2: LINEUP_2 },
    });
  };

  // Hasura's view of the lineup the viewer asks for.
  const joinMatchTeam = async (
    steamId: string,
    id: string,
    onLineup: boolean,
  ) => {
    const lineupId = id.split(":")[1];
    hasura.query
      .mockResolvedValueOnce({ players_by_pk: player(steamId) })
      .mockResolvedValueOnce({
        match_lineups_by_pk: {
          id: lineupId,
          match_id: MATCH_ID,
          coach_steam_id: null,
          is_on_lineup: onLineup,
          match: { status: "Live" },
        },
      });
    const client = {
      id: `c-${steamId}`,
      user: player(steamId),
      send: jest.fn(),
      on: jest.fn(),
    };
    await chat.joinMatchLobby(client as any, ChatLobbyType.MatchTeam, id);
    const history = client.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(payload))
      .find((p: any) => p.event === `lobby:match_team:${id}:messages`);
    return history?.data.messages.map((m: any) => m.message) ?? null;
  };

  it("keeps each side's picking-phase messages in that side's match Team Chat", async () => {
    expect((await post("2", teamA, "pick Tricked")).accepted).toBe(true);
    expect((await post("5", teamA, "I'll AWP")).accepted).toBe(true);
    expect((await post("1", teamB, "B plan")).accepted).toBe(true);

    await createMatch();

    expect(stored(ChatLobbyType.MatchTeam, matchTeamA)).toEqual([
      "I'll AWP",
      "pick Tricked",
    ]);
    expect(stored(ChatLobbyType.MatchTeam, matchTeamB)).toEqual(["B plan"]);
    // Moved, not copied: the draft rooms are gone.
    expect(stored(ChatLobbyType.CaptainPickTeam, teamA)).toEqual([]);
    expect(stored(ChatLobbyType.CaptainPickTeam, teamB)).toEqual([]);
  });

  it("shows a player their own team's history after the draft, never the other team's", async () => {
    await post("5", teamA, "I'll AWP");
    await post("6", teamB, "rush B");
    await createMatch();

    expect(await joinMatchTeam("5", matchTeamA, true)).toEqual(["I'll AWP"]);
    expect(await joinMatchTeam("6", matchTeamB, true)).toEqual(["rush B"]);
    // Asking for the other lineup's room gets nothing at all.
    expect(await joinMatchTeam("5", matchTeamB, false)).toBeNull();
    expect(await joinMatchTeam("6", matchTeamA, false)).toBeNull();
  });

  it("closes the draft rooms once the match exists, so nothing is stranded there", async () => {
    await createMatch();

    for (const [steamId, room] of [
      ["2", teamA],
      ["5", teamA],
      ["1", teamB],
      ["6", teamB],
    ]) {
      await expect(
        canAccessCaptainPickTeamChat(redis as any, room, steamId),
      ).resolves.toBe(false);
      expect((await post(steamId, room, "late")).accepted).toBe(false);
    }
    expect(stored(ChatLobbyType.CaptainPickTeam, teamA)).toEqual([]);
    expect(stored(ChatLobbyType.MatchTeam, matchTeamA)).toEqual([]);
  });

  it("is safe to run again", async () => {
    await post("2", teamA, "pick Tricked");
    await createMatch();
    await createMatch();

    expect(stored(ChatLobbyType.MatchTeam, matchTeamA)).toEqual([
      "pick Tricked",
    ]);
  });

  it("gets ChatService from the matchmaking module's own imports", () => {
    expect(
      Reflect.getMetadata("design:paramtypes", CaptainPickService),
    ).toContain(ChatService);
    // Through forwardRef: chat and matchmaking import each other indirectly
    // (ChatModule -> RconModule -> ... -> MatchMaking), so a plain import
    // would be undefined when MatchMaking is decorated.
    const imported = Reflect.getMetadata("imports", MatchMaking).map(
      (entry: any) => entry?.forwardRef?.() ?? entry,
    );
    expect(imported).toContain(ChatModule);
    expect(imported).not.toContain(undefined);
    expect(Reflect.getMetadata("exports", ChatModule)).toContain(ChatService);
  });
});
