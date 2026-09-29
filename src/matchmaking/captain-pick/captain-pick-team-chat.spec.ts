import { ChatService } from "../../chat/chat.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import { getCaptainPickDraftCacheKey } from "../utilities/cacheKeys";
import {
  CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS,
  canAccessCaptainPickTeamChat,
  captainPickTeamOf,
  getCaptainPickTeamChatId,
  parseCaptainPickTeamChatId,
} from "./captain-pick-team-chat";

const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const DRAFT_KEY = getCaptainPickDraftCacheKey(DRAFT_ID);

// Captain A (lineup 1) = "2", captain B (lineup 2) = "1". Players 3..10 in
// the pool; the tests move them onto sides like real picks would.
const draftState = (
  lineups: { 1: string[]; 2: string[] },
  phase = "Drafting",
) => JSON.stringify({ phase, draft: { lineups } });

const player = (steamId: string): User =>
  ({ steam_id: steamId, name: `P${steamId}`, role: "verified_user" }) as User;

describe("Captain Pick team chat ids", () => {
  it("names a draft and a side", () => {
    expect(getCaptainPickTeamChatId(DRAFT_ID, 1)).toBe(`${DRAFT_ID}:1`);
    expect(parseCaptainPickTeamChatId(`${DRAFT_ID}:2`)).toEqual({
      draftId: DRAFT_ID,
      lineup: 2,
    });
  });

  it("rejects anything that isn't exactly draft:1 or draft:2", () => {
    for (const id of [
      DRAFT_ID,
      `${DRAFT_ID}:0`,
      `${DRAFT_ID}:3`,
      `${DRAFT_ID}:A`,
      `${DRAFT_ID}:1:2`,
      `:1`,
      "",
    ]) {
      expect(parseCaptainPickTeamChatId(id)).toBeNull();
    }
  });

  it("finds a player's side from the committed state only", () => {
    const state = {
      phase: "Drafting",
      draft: { lineups: { 1: ["2", "5"], 2: ["1"] } },
    };
    expect(captainPickTeamOf(state, "2")).toBe(1);
    expect(captainPickTeamOf(state, "5")).toBe(1);
    expect(captainPickTeamOf(state, "1")).toBe(2);
    expect(captainPickTeamOf(state, "7")).toBeNull();
    expect(captainPickTeamOf({ ...state, phase: "Failed" }, "2")).toBeNull();
  });
});

describe("Captain Pick team chat access", () => {
  let draft: string | null;
  const redis = {
    hget: jest.fn(async (key: string, field: string) =>
      key === DRAFT_KEY && field === "state" ? draft : null,
    ),
  };
  const can = (lineup: 1 | 2, steamId: string) =>
    canAccessCaptainPickTeamChat(
      redis as any,
      `${DRAFT_ID}:${lineup}`,
      steamId,
    );

  beforeEach(() => {
    draft = draftState({ 1: ["2"], 2: ["1"] });
  });

  it("gives each captain their own team chat from the start, and only that", async () => {
    await expect(can(1, "2")).resolves.toBe(true);
    await expect(can(2, "1")).resolves.toBe(true);
    await expect(can(2, "2")).resolves.toBe(false);
    await expect(can(1, "1")).resolves.toBe(false);
  });

  it("gives an unpicked player neither team chat", async () => {
    await expect(can(1, "5")).resolves.toBe(false);
    await expect(can(2, "5")).resolves.toBe(false);
  });

  it("opens the right team chat the moment the server commits the pick", async () => {
    draft = draftState({ 1: ["2", "5"], 2: ["1"] });
    await expect(can(1, "5")).resolves.toBe(true);
    await expect(can(2, "5")).resolves.toBe(false);

    draft = draftState({ 1: ["2", "5"], 2: ["1", "6"] });
    await expect(can(2, "6")).resolves.toBe(true);
    await expect(can(1, "6")).resolves.toBe(false);
  });

  it("includes the last player the server placed on Team A", async () => {
    draft = draftState(
      {
        1: ["2", "3", "6", "7", "10"],
        2: ["1", "4", "5", "8", "9"],
      },
      "CreatingMatch",
    );
    await expect(can(1, "10")).resolves.toBe(true);
    await expect(can(2, "10")).resolves.toBe(false);
  });

  it("denies outsiders, missing drafts, broken state and failed drafts", async () => {
    await expect(can(1, "999")).resolves.toBe(false);

    draft = null;
    await expect(can(1, "2")).resolves.toBe(false);

    draft = "{not json";
    await expect(can(1, "2")).resolves.toBe(false);

    draft = draftState({ 1: ["2"], 2: ["1"] }, "Failed");
    await expect(can(1, "2")).resolves.toBe(false);
  });

  it("can't be tricked by a malformed room id", async () => {
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:1:2`, "2"),
    ).resolves.toBe(false);
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `other-draft:1`, "2"),
    ).resolves.toBe(false);
  });
});

describe("ChatService with Captain Pick team chat", () => {
  let service: ChatService;
  let draft: string;
  let redis: Record<string, jest.Mock>;
  let hasura: { query: jest.Mock };
  const teamA = `${DRAFT_ID}:1`;
  const teamB = `${DRAFT_ID}:2`;

  beforeEach(() => {
    // Captain A "2" picked "5"; "6" is still unpicked; "1" captains B.
    draft = draftState({ 1: ["2", "5"], 2: ["1"] });
    hasura = { query: jest.fn() };
    redis = {
      hget: jest.fn(async (key: string, field: string) => {
        if (key === DRAFT_KEY && field === "state") return draft;
        // Every sender below already "joined" some room earlier.
        return JSON.stringify({ user: { steam_id: "x" } });
      }),
      hgetall: jest.fn().mockResolvedValue({}),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1]),
      get: jest.fn().mockResolvedValue(null),
      publish: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
    };
    service = new ChatService(
      { warn: jest.fn(), error: jest.fn() } as any,
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
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);
  });

  const join = async (steamId: string, id: string) => {
    hasura.query.mockResolvedValueOnce({ players_by_pk: player(steamId) });
    const client = {
      id: `c-${steamId}`,
      user: player(steamId),
      send: jest.fn(),
      on: jest.fn(),
    };
    await service.joinMatchLobby(
      client as any,
      ChatLobbyType.CaptainPickTeam,
      id,
    );
    return client.send.mock.calls.map(([payload]: [string]) =>
      JSON.parse(payload),
    );
  };

  it("lets a picked player join their own team chat with its history", async () => {
    redis.hgetall.mockResolvedValue({
      m1: JSON.stringify({
        id: "m1",
        message: "please pick Tricked",
        timestamp: "2026-09-30T10:00:00.000Z",
        from: { steam_id: "2", name: "P2" },
      }),
    });

    const sent = await join("5", teamA);

    const history = sent.find(
      (p) => p.event === `lobby:captain_pick_team:${teamA}:messages`,
    );
    expect(history.data.messages.map((m: any) => m.message)).toEqual([
      "please pick Tricked",
    ]);
    expect(redis.hgetall).toHaveBeenCalledWith(
      `chat_captain_pick_team_${teamA}`,
    );
  });

  it("never sends the other team's history, whatever room id the client asks for", async () => {
    redis.hgetall.mockResolvedValue({
      m1: JSON.stringify({
        id: "m1",
        message: "secret",
        from: { steam_id: "1" },
      }),
    });

    expect(await join("5", teamB)).toEqual([]);
    expect(await join("2", teamB)).toEqual([]);
    expect(await join("6", teamA)).toEqual([]);
    expect(await join("6", teamB)).toEqual([]);
    expect(await join("999", teamA)).toEqual([]);
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it("lets a team member post to their own team chat", async () => {
    const result = await service.sendMessageToChat(
      ChatLobbyType.CaptainPickTeam,
      teamA,
      player("5"),
      "please pick Tricked",
    );

    expect(result.accepted).toBe(true);
    expect(service.to).toHaveBeenCalledWith(
      ChatLobbyType.CaptainPickTeam,
      teamA,
      "chat",
      expect.objectContaining({ message: "please pick Tricked" }),
      expect.any(Function),
    );
  });

  it("refuses posting to the other team or while unpicked, even with a stale session", async () => {
    for (const [steamId, id] of [
      ["5", teamB],
      ["2", teamB],
      ["1", teamA],
      ["6", teamA],
      ["6", teamB],
    ]) {
      const result = await service.sendMessageToChat(
        ChatLobbyType.CaptainPickTeam,
        id,
        player(steamId),
        "hello",
      );
      expect(result.accepted).toBe(false);
    }
    expect(service.to).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("keeps team messages only as long as the draft", async () => {
    await service.sendMessageToChat(
      ChatLobbyType.CaptainPickTeam,
      teamA,
      player("2"),
      "gl",
    );

    const expiry = redis.sendCommand.mock.calls.find(
      ([command]: any[]) => String(command?.name).toUpperCase() === "HEXPIRE",
    );
    expect(expiry?.[0].args[1]).toBe(
      String(CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS),
    );
  });
});
