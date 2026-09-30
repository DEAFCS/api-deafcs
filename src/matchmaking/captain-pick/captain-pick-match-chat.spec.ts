import { ChatService } from "../../chat/chat.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import { getCaptainPickDraftCacheKey } from "../utilities/cacheKeys";
import {
  CAPTAIN_PICK_MATCH_CHAT_TTL_SECONDS,
  CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS,
  canAccessCaptainPickMatchChat,
  canAccessCaptainPickTeamChat,
} from "./captain-pick-team-chat";
import { CAPTAIN_PICK_STATE_TTL_SECONDS } from "./captain-pick.service";

const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const DRAFT_KEY = getCaptainPickDraftCacheKey(DRAFT_ID);
const OTHER_DRAFT_KEY = getCaptainPickDraftCacheKey(OTHER_DRAFT_ID);

// Ten committed players "1".."10"; captains "2" (lineup 1) and "1" (lineup 2).
const TEN = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

const draftState = (
  participants: string[],
  lineups: { 1: string[]; 2: string[] } = { 1: ["2"], 2: ["1"] },
  phase = "Drafting",
) =>
  JSON.stringify({
    phase,
    participants: participants.map((steam_id) => ({ steam_id })),
    draft: { lineups },
  });

const player = (steamId: string, role = "verified_user"): User =>
  ({ steam_id: steamId, name: `P${steamId}`, role }) as User;

describe("Captain Pick match chat access", () => {
  let draft: string | null;
  let otherDraft: string | null;
  const redis = {
    hget: jest.fn(async (key: string, field: string) => {
      if (field !== "state") return null;
      if (key === DRAFT_KEY) return draft;
      if (key === OTHER_DRAFT_KEY) return otherDraft;
      return null;
    }),
  };
  const can = (steamId: string, id = DRAFT_ID) =>
    canAccessCaptainPickMatchChat(redis as any, id, steamId);

  beforeEach(() => {
    draft = draftState(TEN);
    otherDraft = draftState([
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
    ]);
  });

  it("lets every one of the ten committed players in, picked or not", async () => {
    for (const steamId of TEN) {
      await expect(can(steamId)).resolves.toBe(true);
    }
  });

  it("denies outsiders and players from another draft", async () => {
    await expect(can("999")).resolves.toBe(false);
    await expect(can("11")).resolves.toBe(false);
    await expect(can("2", OTHER_DRAFT_ID)).resolves.toBe(false);
  });

  it("denies malformed and nonexistent draft ids, broken and failed drafts", async () => {
    for (const id of ["", `${DRAFT_ID}:1`, `${DRAFT_ID}:`, "missing-draft"]) {
      await expect(can("2", id)).resolves.toBe(false);
    }
    draft = "{not json";
    await expect(can("2")).resolves.toBe(false);
    draft = draftState(TEN, undefined, "Failed");
    await expect(can("2")).resolves.toBe(false);
    draft = null;
    await expect(can("2")).resolves.toBe(false);
  });

  it("keeps Captain Pick team chat side-only, unchanged", async () => {
    // Everyone is in the shared room, only captain "2" is on side 1 so far.
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:1`, "2"),
    ).resolves.toBe(true);
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:1`, "5"),
    ).resolves.toBe(false);
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:2`, "2"),
    ).resolves.toBe(false);
    // The shared room id is never a team room id.
    await expect(
      canAccessCaptainPickTeamChat(redis as any, DRAFT_ID, "2"),
    ).resolves.toBe(false);
  });

  it("lives no longer than the draft", () => {
    expect(CAPTAIN_PICK_MATCH_CHAT_TTL_SECONDS).toBe(
      CAPTAIN_PICK_TEAM_CHAT_TTL_SECONDS,
    );
    expect(CAPTAIN_PICK_MATCH_CHAT_TTL_SECONDS).toBe(
      CAPTAIN_PICK_STATE_TTL_SECONDS,
    );
  });
});

describe("ChatService with Captain Pick match chat", () => {
  let service: ChatService;
  let draft: string;
  let redis: Record<string, jest.Mock>;
  let hasura: { query: jest.Mock };
  let notifications: { notifyPlayers: jest.Mock; sendSilent: jest.Mock };
  let postgres: { query: jest.Mock };
  let hashes: Record<string, Record<string, string>>;
  let strings: Record<string, string>;

  beforeEach(() => {
    draft = draftState(TEN);
    hashes = {};
    strings = {};
    hasura = { query: jest.fn() };
    notifications = { notifyPlayers: jest.fn(), sendSilent: jest.fn() };
    postgres = { query: jest.fn().mockResolvedValue([]) };
    redis = {
      hget: jest.fn(async (key: string, field: string) => {
        if (key === DRAFT_KEY && field === "state") return draft;
        // Every sender below already "joined" some room earlier.
        return JSON.stringify({ user: { steam_id: "x" } });
      }),
      hgetall: jest.fn(async (key: string) => ({ ...(hashes[key] ?? {}) })),
      hset: jest.fn(async (key: string, field: string, value: string) => {
        hashes[key] = { ...(hashes[key] ?? {}), [field]: value };
        return 1;
      }),
      hdel: jest.fn(async (key: string, ...fields: string[]) => {
        for (const field of fields) delete hashes[key]?.[field];
        return fields.length;
      }),
      del: jest.fn(async (...keys: string[]) => {
        for (const key of keys) delete hashes[key];
        return keys.length;
      }),
      exists: jest.fn(async (key: string) =>
        hashes[key] && Object.keys(hashes[key]).length ? 1 : 0,
      ),
      keys: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1]),
      get: jest.fn(async (key: string) => strings[key] ?? null),
      set: jest.fn().mockResolvedValue("OK"),
      publish: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn(() => ({
        expire: jest.fn(),
        exec: jest.fn().mockResolvedValue([]),
      })),
    };
    service = new ChatService(
      { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      notifications as any,
      {
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
        hasBlocked: jest.fn().mockResolvedValue(false),
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
    jest.spyOn(service, "to").mockResolvedValue(undefined);
  });

  const join = async (user: User, type: ChatLobbyType, id: string) => {
    hasura.query.mockResolvedValueOnce({ players_by_pk: user });
    const client = {
      id: `c-${user.steam_id}`,
      user,
      send: jest.fn(),
      on: jest.fn(),
    };
    await service.joinMatchLobby(client as any, type, id);
    return client.send.mock.calls.map(([payload]: [string]) =>
      JSON.parse(payload),
    );
  };

  const history = (sent: any[], type: string, id: string) =>
    sent.find((p) => p.event === `lobby:${type}:${id}:messages`);

  it("lets a committed player join the shared chat with its history", async () => {
    hashes[`chat_captain_pick_match_${DRAFT_ID}`] = {
      m1: JSON.stringify({
        id: "m1",
        message: "gl hf",
        timestamp: "2026-09-30T10:00:00.000Z",
        from: { steam_id: "7", name: "P7" },
      }),
    };

    // An unpicked player: no side yet, but part of the draft.
    const sent = await join(
      player("7"),
      ChatLobbyType.CaptainPickMatch,
      DRAFT_ID,
    );

    expect(
      history(sent, "captain_pick_match", DRAFT_ID).data.messages.map(
        (m: any) => m.message,
      ),
    ).toEqual(["gl hf"]);
  });

  it("refuses outsiders, other drafts and non-participant admins/organizers", async () => {
    hashes[`chat_captain_pick_match_${DRAFT_ID}`] = {
      m1: JSON.stringify({
        id: "m1",
        message: "secret",
        from: { steam_id: "2" },
      }),
    };

    for (const user of [
      player("999"),
      player("11"),
      player("998", "administrator"),
      player("997", "match_organizer"),
    ]) {
      expect(
        await join(user, ChatLobbyType.CaptainPickMatch, DRAFT_ID),
      ).toEqual([]);
    }
    expect(
      await join(player("2"), ChatLobbyType.CaptainPickMatch, OTHER_DRAFT_ID),
    ).toEqual([]);
    expect(
      await join(player("2"), ChatLobbyType.CaptainPickMatch, `${DRAFT_ID}:1`),
    ).toEqual([]);
    expect(redis.hgetall).not.toHaveBeenCalledWith(
      `chat_captain_pick_match_${DRAFT_ID}`,
    );
  });

  it("lets a committed player post; refuses anyone else, even with a stale session", async () => {
    const ok = await service.sendMessageToChat(
      ChatLobbyType.CaptainPickMatch,
      DRAFT_ID,
      player("9"),
      "rush B",
    );
    expect(ok.accepted).toBe(true);

    for (const user of [player("999"), player("998", "administrator")]) {
      const result = await service.sendMessageToChat(
        ChatLobbyType.CaptainPickMatch,
        DRAFT_ID,
        user,
        "hello",
      );
      expect(result.accepted).toBe(false);
    }

    // The draft failed: nobody can keep talking in it.
    draft = draftState(TEN, undefined, "Failed");
    const late = await service.sendMessageToChat(
      ChatLobbyType.CaptainPickMatch,
      DRAFT_ID,
      player("9"),
      "still here?",
    );
    expect(late.accepted).toBe(false);
  });

  it("does not take attachments or GIFs (it becomes the match chat)", async () => {
    const sendGif = (type: ChatLobbyType, id: string, steamId: string) =>
      service.sendMessageToChat(
        type,
        id,
        player(steamId),
        "",
        false,
        undefined,
        undefined,
        "website",
        "https://media.giphy.com/media/abc/giphy.gif",
      );

    expect(
      (await sendGif(ChatLobbyType.CaptainPickMatch, DRAFT_ID, "2")).accepted,
    ).toBe(false);
    // Control: the team room still takes the same GIF.
    expect(
      (await sendGif(ChatLobbyType.CaptainPickTeam, `${DRAFT_ID}:1`, "2"))
        .accepted,
    ).toBe(true);
  });

  it("keeps messages only as long as the draft", async () => {
    await service.sendMessageToChat(
      ChatLobbyType.CaptainPickMatch,
      DRAFT_ID,
      player("2"),
      "gl",
    );

    const expiry = redis.sendCommand.mock.calls.find(
      ([command]: any[]) => String(command?.name).toUpperCase() === "HEXPIRE",
    );
    expect(expiry?.[0].args[1]).toBe(
      String(CAPTAIN_PICK_MATCH_CHAT_TTL_SECONDS),
    );
  });

  it.each([
    ChatLobbyType.CaptainPickMatch,
    ChatLobbyType.Match,
    ChatLobbyType.MatchTeam,
    ChatLobbyType.Draft,
  ])("sends no push and no unread fallback for %s", async (type) => {
    const roster = jest.spyOn(service as any, "getLobbyMemberSteamIds");

    await (service as any).notifyLobbyMembers(
      type,
      DRAFT_ID,
      player("2"),
      "hello",
    );

    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    expect(notifications.sendSilent).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
  });

  describe("handover to the real match chat", () => {
    const matchAccess = {
      matches_by_pk: {
        is_coach: false,
        is_organizer: false,
        is_in_lineup: true,
      },
    };
    const joinMatch = async (steamId = "2") => {
      hasura.query
        .mockResolvedValueOnce({ players_by_pk: player(steamId) })
        .mockResolvedValueOnce(matchAccess);
      const client = {
        id: `c-${steamId}`,
        user: player(steamId),
        send: jest.fn(),
        on: jest.fn(),
      };
      await service.joinMatchLobby(
        client as any,
        ChatLobbyType.Match,
        MATCH_ID,
      );
      return client.send.mock.calls.map(([payload]: [string]) =>
        JSON.parse(payload),
      );
    };
    const sourceKey = `chat_captain_pick_match_${DRAFT_ID}`;
    const matchKey = `chat_match_${MATCH_ID}`;
    const stored = (id: string, message: string, at: string) =>
      JSON.stringify({
        id,
        message,
        timestamp: at,
        from: { steam_id: "2", name: "P2" },
      });

    beforeEach(() => {
      strings[`matches:confirmation:${MATCH_ID}`] = DRAFT_ID;
      hashes[sourceKey] = {
        m1: stored("m1", "first", "2026-09-30T10:00:00.000Z"),
        m2: stored("m2", "second", "2026-09-30T10:01:00.000Z"),
      };
    });

    it("carries the draft chat into the match chat, keeping ids and timestamps", async () => {
      const sent = await joinMatch();

      expect(Object.keys(hashes[matchKey]).sort()).toEqual(["m1", "m2"]);
      expect(JSON.parse(hashes[matchKey].m1).timestamp).toBe(
        "2026-09-30T10:00:00.000Z",
      );
      expect(hashes[sourceKey]).toBeUndefined();
      expect(
        history(sent, "match", MATCH_ID).data.messages.map((m: any) => m.id),
      ).toEqual(expect.arrayContaining(["m1", "m2"]));
    });

    it("never duplicates on a retry or a second player joining", async () => {
      await joinMatch("2");
      await joinMatch("5");
      // A late message sent to the draft chat after the first handover.
      hashes[sourceKey] = {
        m3: stored("m3", "late", "2026-09-30T10:02:00.000Z"),
      };
      await joinMatch("7");

      expect(Object.keys(hashes[matchKey]).sort()).toEqual(["m1", "m2", "m3"]);
    });

    it("does not bring back a message deleted in the draft chat", async () => {
      postgres.query.mockImplementation(async (_sql: string, params: any[]) =>
        params?.[0] === ChatLobbyType.CaptainPickMatch
          ? [{ message_id: "m2" }]
          : [],
      );

      await joinMatch();

      expect(Object.keys(hashes[matchKey])).toEqual(["m1"]);
    });

    it("leaves ordinary matches alone", async () => {
      delete strings[`matches:confirmation:${MATCH_ID}`];
      await joinMatch();
      expect(hashes[matchKey]).toBeUndefined();
      expect(Object.keys(hashes[sourceKey])).toEqual(["m1", "m2"]);
    });

    it("still lets the player into the match chat if the handover fails", async () => {
      redis.exists.mockRejectedValueOnce(new Error("redis down"));
      const sent = await joinMatch();
      expect(history(sent, "match", MATCH_ID)).toBeDefined();
    });

    it("does nothing for someone the match chat refuses", async () => {
      hasura.query
        .mockResolvedValueOnce({ players_by_pk: player("999") })
        .mockResolvedValueOnce({
          matches_by_pk: {
            is_coach: false,
            is_organizer: false,
            is_in_lineup: false,
          },
        });
      const client = {
        id: "c-999",
        user: player("999"),
        send: jest.fn(),
        on: jest.fn(),
      };
      await service.joinMatchLobby(
        client as any,
        ChatLobbyType.Match,
        MATCH_ID,
      );

      expect(client.send).not.toHaveBeenCalled();
      expect(Object.keys(hashes[sourceKey])).toEqual(["m1", "m2"]);
    });
  });
});
