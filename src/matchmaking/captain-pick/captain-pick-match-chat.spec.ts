import { ChatService } from "../../chat/chat.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import {
  getCaptainPickDraftCacheKey,
  getMatchConfirmationKey,
} from "../utilities/cacheKeys";
import {
  canAccessCaptainPickTeamChat,
  isCaptainPickPlayerOfMatch,
} from "./captain-pick-team-chat";

// During Captain Pick the draft's ten players share the real match's
// ordinary Match chat, before any of them is seated in its lineups.

const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_MATCH_ID = "66666666-6666-4666-8666-666666666666";

// Ten committed players "1".."10"; captains "2" (lineup 1) and "1" (lineup 2).
const TEN = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

const draftState = (
  overrides: Record<string, unknown> = {},
  participants: string[] = TEN,
) =>
  JSON.stringify({
    phase: "Drafting",
    matchId: MATCH_ID,
    participants: participants.map((steam_id) => ({ steam_id })),
    draft: { lineups: { 1: ["2"], 2: ["1"] } },
    ...overrides,
  });

const player = (steamId: string, role = "verified_user"): User =>
  ({ steam_id: steamId, name: `P${steamId}`, role }) as User;

function fakeRedis() {
  const strings: Record<string, string> = {
    [getMatchConfirmationKey(MATCH_ID)]: DRAFT_ID,
    [getMatchConfirmationKey(OTHER_MATCH_ID)]: OTHER_DRAFT_ID,
  };
  const drafts: Record<string, string | null> = {
    [getCaptainPickDraftCacheKey(DRAFT_ID)]: draftState(),
    [getCaptainPickDraftCacheKey(OTHER_DRAFT_ID)]: draftState(
      { matchId: OTHER_MATCH_ID },
      ["11", "12", "13", "14", "15", "16", "17", "18", "19", "20"],
    ),
  };
  return {
    strings,
    drafts,
    get: jest.fn(async (key: string) => strings[key] ?? null),
    hget: jest.fn(async (key: string, field: string) => {
      if (key in drafts) return field === "state" ? drafts[key] : null;
      // Chat session data: every sender below "joined" earlier.
      return JSON.stringify({ user: { steam_id: "x" } });
    }),
  };
}

describe("Captain Pick players in the match's Match chat", () => {
  let redis: ReturnType<typeof fakeRedis>;
  const can = (
    steamId: string,
    status = "PickingPlayers",
    matchId = MATCH_ID,
  ) => isCaptainPickPlayerOfMatch(redis as any, matchId, status, steamId);

  beforeEach(() => {
    redis = fakeRedis();
  });

  it("lets every one of the ten committed players in while picking", async () => {
    for (const steamId of TEN) {
      await expect(can(steamId)).resolves.toBe(true);
    }
  });

  it("refuses outsiders and another draft's players", async () => {
    await expect(can("999")).resolves.toBe(false);
    await expect(can("11")).resolves.toBe(false);
    await expect(can("2", "PickingPlayers", OTHER_MATCH_ID)).resolves.toBe(
      false,
    );
  });

  it("only applies while the match is still picking players", async () => {
    // From veto on they are seated; the normal lineup rule decides.
    for (const status of ["Veto", "Live", "Finished", "Canceled"]) {
      await expect(can("7", status)).resolves.toBe(false);
    }
  });

  it("refuses a match with no draft, a missing, broken or failed draft, or a draft for another match", async () => {
    await expect(
      can("2", "PickingPlayers", "77777777-7777-4777-8777-777777777777"),
    ).resolves.toBe(false);

    const key = getCaptainPickDraftCacheKey(DRAFT_ID);
    redis.drafts[key] = null;
    await expect(can("2")).resolves.toBe(false);
    redis.drafts[key] = "{not json";
    await expect(can("2")).resolves.toBe(false);
    redis.drafts[key] = draftState({ phase: "Failed" });
    await expect(can("2")).resolves.toBe(false);
    // A stale/wrong mapping never opens a match the draft isn't for.
    redis.drafts[key] = draftState({ matchId: OTHER_MATCH_ID });
    await expect(can("2")).resolves.toBe(false);
  });

  it("leaves Captain Pick team chat side-only", async () => {
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:1`, "2"),
    ).resolves.toBe(true);
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:1`, "7"),
    ).resolves.toBe(false);
    await expect(
      canAccessCaptainPickTeamChat(redis as any, `${DRAFT_ID}:2`, "2"),
    ).resolves.toBe(false);
  });
});

describe("ChatService Match chat during Captain Pick", () => {
  let service: ChatService;
  let redis: ReturnType<typeof fakeRedis> & Record<string, any>;
  let hasura: { query: jest.Mock };
  let notifications: { notifyPlayers: jest.Mock; sendSilent: jest.Mock };

  beforeEach(() => {
    redis = Object.assign(fakeRedis(), {
      hgetall: jest.fn().mockResolvedValue({}),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1]),
      publish: jest.fn().mockResolvedValue(1),
      sendCommand: jest.fn().mockResolvedValue(1),
    });
    hasura = { query: jest.fn() };
    notifications = { notifyPlayers: jest.fn(), sendSilent: jest.fn() };
    service = new ChatService(
      { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
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

  // What matches_by_pk says for this viewer: nobody is seated during picking.
  const joinMatch = async (
    user: User,
    access: Partial<
      Record<"is_coach" | "is_organizer" | "is_in_lineup", boolean>
    > = {},
    status = "PickingPlayers",
    matchId = MATCH_ID,
  ) => {
    hasura.query
      .mockResolvedValueOnce({ players_by_pk: user })
      .mockResolvedValueOnce({
        matches_by_pk: {
          is_coach: false,
          is_organizer: false,
          is_in_lineup: false,
          status,
          ...access,
        },
      });
    const client = {
      id: `c-${user.steam_id}`,
      user,
      send: jest.fn(),
      on: jest.fn(),
    };
    await service.joinMatchLobby(client as any, ChatLobbyType.Match, matchId);
    return client.send.mock.calls.map(([payload]: [string]) =>
      JSON.parse(payload),
    );
  };
  const joined = (sent: any[]) =>
    sent.some((p) => p.event === `lobby:match:${MATCH_ID}:messages`);

  it("lets all ten draft players into the match's Match chat before they are seated", async () => {
    for (const steamId of TEN) {
      expect(joined(await joinMatch(player(steamId)))).toBe(true);
    }
    // The ordinary Match room -- no separate draft room.
    expect(redis.hgetall).toHaveBeenCalledWith(`chat_match_${MATCH_ID}`);
  });

  it("keeps a spectator out", async () => {
    expect(await joinMatch(player("999"))).toEqual([]);
    expect(await joinMatch(player("11"))).toEqual([]);
  });

  it("keeps the existing admin/organizer access to the shared Match chat", async () => {
    expect(
      joined(
        await joinMatch(player("998", "administrator"), { is_organizer: true }),
      ),
    ).toBe(true);
  });

  it("does not open other PickingPlayers matches to anyone", async () => {
    // A custom match being set up: no draft behind it.
    const sent = await joinMatch(
      player("2"),
      {},
      "PickingPlayers",
      "77777777-7777-4777-8777-777777777777",
    );
    expect(sent).toEqual([]);
  });

  it("uses the same permission check for other Match chat actions", async () => {
    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        is_coach: false,
        is_organizer: false,
        is_in_lineup: false,
        status: "PickingPlayers",
      },
    });
    await expect(
      (service as any).hasLobbyPermission(
        ChatLobbyType.Match,
        MATCH_ID,
        player("7"),
      ),
    ).resolves.toBe(true);

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        is_coach: false,
        is_organizer: false,
        is_in_lineup: false,
        status: "PickingPlayers",
      },
    });
    await expect(
      (service as any).hasLobbyPermission(
        ChatLobbyType.Match,
        MATCH_ID,
        player("999"),
      ),
    ).resolves.toBe(false);
  });

  it("sends no push and no unread fallback for Match chat, as before", async () => {
    await (service as any).notifyLobbyMembers(
      ChatLobbyType.Match,
      MATCH_ID,
      player("2"),
      "gl",
    );
    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    expect(notifications.sendSilent).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
