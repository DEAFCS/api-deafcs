import { Logger } from "@nestjs/common";
import { ChatService } from "../../chat/chat.service";
import { ChatModule } from "../../chat/chat.module";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import { getCaptainPickDraftCacheKey } from "../utilities/cacheKeys";
import { CaptainPickService } from "./captain-pick.service";
import { canAccessCaptainPickTeamChat } from "./captain-pick-team-chat";
import { MatchMaking } from "../matchmaking.module";
import { CaptainPickTeamChatCarryOver } from "../jobs/CaptainPickTeamChatCarryOver";
import {
  ExpireChatAttachmentJobName,
  ExpireSentChatVideoMediaJobName,
} from "../../chat/enums/ChatVideoQueues";

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
  const strings = new Map<string, string>();
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key)!;
  };
  const redis: Record<string, any> = {
    hashes,
    strings,
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
      keys.forEach((key) => {
        hashes.delete(key);
        strings.delete(key);
      });
      return keys.length;
    }),
    keys: jest.fn(async (): Promise<string[]> => []),
    expire: jest.fn(async () => 1),
    eval: jest.fn(async (script: string) =>
      script.includes("INCR") ? 1 : [1, 1],
    ),
    get: jest.fn(async (key: string) => strings.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return "OK";
    }),
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
  let s3: { remove: jest.Mock; has: jest.Mock };
  let cleanup: { add: jest.Mock; getJob: jest.Mock };
  let matchmakingQueue: { add: jest.Mock };

  beforeEach(() => {
    redis = memoryRedis();
    redis.hashes.set(
      DRAFT_KEY,
      new Map([["state", draftState("CreatingMatch")]]),
    );
    hasura = { query: jest.fn() };
    s3 = { remove: jest.fn(async () => true), has: jest.fn(async () => false) };
    cleanup = {
      add: jest.fn(async () => ({})),
      getJob: jest.fn(async (): Promise<null> => null),
    };
    matchmakingQueue = { add: jest.fn(async () => ({})) };
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
      s3 as any,
      cleanup as any,
    );
    jest.spyOn(chat, "to").mockResolvedValue(undefined);
    jest.spyOn(chat as any, "notifyLobbyMembers").mockResolvedValue(undefined);

    captainPick = new CaptainPickService(
      new Logger("CaptainPickTeamChatContinuity"),
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      matchmakingQueue as any,
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

  // Hasura's lineup row for a viewer of either match Team Chat.
  const asLineup = (onLineup: boolean, lineupId: string) =>
    hasura.query.mockResolvedValueOnce({
      match_lineups_by_pk: {
        id: lineupId,
        match_id: MATCH_ID,
        coach_steam_id: null,
        is_on_lineup: onLineup,
        match: { status: "Live" },
      },
    });

  it("keeps GIFs, uploads and videos, and only that team can open the files", async () => {
    const attachmentId = "0123456789abcdef";
    const objectKey = `chat-attachments/5/${attachmentId}.png`;
    const draftRoom = `chat_${ChatLobbyType.CaptainPickTeam}_${teamA}`;
    redis.hashes.set(
      draftRoom,
      new Map([
        [
          "m1",
          JSON.stringify({
            id: "m1",
            message: "",
            gifUrl: "https://media.giphy.com/media/x/giphy.gif",
            timestamp: "2026-10-16T10:00:00.000Z",
            from: { steam_id: "2" },
          }),
        ],
        [
          "m2",
          JSON.stringify({
            id: "m2",
            message: "",
            attachment: { id: attachmentId, contentType: "image/png" },
            timestamp: "2026-10-16T10:00:01.000Z",
            from: { steam_id: "5" },
          }),
        ],
        [
          "m3",
          JSON.stringify({
            id: "m3",
            message: "",
            media: { type: "video", id: "v1" },
            timestamp: "2026-10-16T10:00:02.000Z",
            from: { steam_id: "5" },
          }),
        ],
      ]),
    );
    redis.strings.set(
      (chat as any).chatAttachmentKey(attachmentId),
      JSON.stringify({
        objectKey,
        contentType: "image/png",
        chatType: ChatLobbyType.CaptainPickTeam,
        roomId: teamA,
      }),
    );
    redis.strings.set(
      (chat as any).videoMediaKey("v1"),
      JSON.stringify({
        objectKey: "chat-videos/v1.mp4",
        chatType: ChatLobbyType.CaptainPickTeam,
        roomId: teamA,
      }),
    );

    await createMatch();

    const carried = Object.fromEntries(
      [
        ...redis.hashes.get(`chat_${ChatLobbyType.MatchTeam}_${matchTeamA}`)!,
      ].map(([id, raw]) => [id, JSON.parse(raw)]),
    );
    expect(carried.m1.gifUrl).toBe("https://media.giphy.com/media/x/giphy.gif");
    expect(carried.m2.attachment).toEqual({
      id: attachmentId,
      contentType: "image/png",
    });
    expect(carried.m3.media).toEqual({ type: "video", id: "v1" });
    // Files are kept, now belong to Team A's match room, and are removed when
    // that room's messages expire.
    expect(s3.remove).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        redis.strings.get((chat as any).chatAttachmentKey(attachmentId))!,
      ),
    ).toMatchObject({
      objectKey,
      chatType: ChatLobbyType.MatchTeam,
      roomId: matchTeamA,
    });
    expect(
      JSON.parse(redis.strings.get((chat as any).videoMediaKey("v1"))!),
    ).toMatchObject({ chatType: ChatLobbyType.MatchTeam, roomId: matchTeamA });
    expect(cleanup.add.mock.calls.map(([name]) => name).sort()).toEqual(
      [ExpireChatAttachmentJobName, ExpireSentChatVideoMediaJobName].sort(),
    );

    // Team A may open the upload; Team B, asking with the same id, may not.
    asLineup(true, LINEUP_1);
    await expect(
      chat.getChatAttachmentForViewer(attachmentId, player("5")),
    ).resolves.toEqual({ objectKey, contentType: "image/png" });
    asLineup(false, LINEUP_1);
    await expect(
      chat.getChatAttachmentForViewer(attachmentId, player("6")),
    ).resolves.toBeUndefined();
  });

  it("recovers the whole history when the first carry-over fails", async () => {
    await post("2", teamA, "pick Tricked");
    await post("1", teamB, "B plan");
    redis.hashes.get(DRAFT_KEY)!.set("state", draftState("MatchCreated"));
    jest
      .spyOn((captainPick as any).logger, "warn")
      .mockImplementation(() => {});
    const migrate = jest
      .spyOn(chat, "migrateLobbyMessages")
      .mockRejectedValueOnce(new Error("redis down"));

    await (captainPick as any).carryOverTeamChat(DRAFT_ID, {
      id: MATCH_ID,
      status: "Live",
      lineupIds: { 1: LINEUP_1, 2: LINEUP_2 },
    });

    // Nothing lost: still in the draft rooms, and a retry is queued.
    expect(stored(ChatLobbyType.CaptainPickTeam, teamA)).toEqual([
      "pick Tricked",
    ]);
    expect(matchmakingQueue.add).toHaveBeenCalledTimes(1);
    const [name, data] = matchmakingQueue.add.mock.calls[0];
    expect(name).toBe("CaptainPickTeamChatCarryOver");

    await new CaptainPickTeamChatCarryOver(captainPick).process({
      data,
    } as any);

    expect(migrate).toHaveBeenCalledTimes(3);
    expect(stored(ChatLobbyType.MatchTeam, matchTeamA)).toEqual([
      "pick Tricked",
    ]);
    expect(stored(ChatLobbyType.MatchTeam, matchTeamB)).toEqual(["B plan"]);
    expect(stored(ChatLobbyType.CaptainPickTeam, teamA)).toEqual([]);
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
