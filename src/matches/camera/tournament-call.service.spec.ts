import {
  TournamentCallService,
  TournamentCallError,
  TOURNAMENT_CALL_FULL_MESSAGE,
} from "./tournament-call.service";
import { ChatLobbyType } from "../../chat/enums/ChatLobbyTypes";
import { User } from "../../auth/types/User";
import { e_player_roles_enum } from "generated";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const user = (
  steamId: string,
  role: e_player_roles_enum = "verified_user",
): User => ({
  name: `P${steamId}`,
  role,
  steam_id: steamId,
});

// In-memory Redis. `eval` mirrors RESERVE_SLOT_SCRIPT (its Lua text is
// asserted separately below).
function fakeRedis() {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const redis: any = {
    kv,
    hashes,
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      kv.set(k, v);
      return "OK";
    }),
    del: jest.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
    hdel: jest.fn(async (k: string, f: string) =>
      hashes.get(k)?.delete(f) ? 1 : 0,
    ),
    multi: jest.fn(() => {
      const ops: Array<() => void> = [];
      const chain: any = {
        set: (k: string, v: string) => {
          ops.push(() => kv.set(k, v));
          return chain;
        },
        exec: async () => ops.forEach((op) => op()),
      };
      return chain;
    }),
    eval: jest.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        now: string,
        expiresAt: string,
        max: string,
        self: string,
        ...live: string[]
      ) => {
        const hash = hashes.get(key) ?? new Map<string, string>();
        hashes.set(key, hash);
        const occupied = new Set<string>();
        for (const [field, exp] of [...hash.entries()]) {
          if (Number(exp) <= Number(now)) hash.delete(field);
          else if (field !== self) occupied.add(field);
        }
        for (const id of live) if (id !== self) occupied.add(id);
        if (occupied.size >= Number(max)) return 0;
        hash.set(self, expiresAt);
        return 1;
      },
    ),
  };
  return redis;
}

function setup() {
  const live = new Set<string>(); // mediamtx paths currently publishing
  const access = new Map<string, Set<string>>([
    [T1, new Set()],
    [T2, new Set()],
  ]);
  const organizers = new Map<string, Set<string>>([
    [T1, new Set()],
    [T2, new Set()],
  ]);
  const tournaments: Record<
    string,
    { status: string; finished_at: string | null }
  > = {
    [T1]: { status: "Live", finished_at: null },
    [T2]: { status: "Live", finished_at: null },
  };

  const media = {
    participantsForPrefix: jest.fn(async (prefix: string) =>
      [...live]
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({
          steamId: p.slice(prefix.length),
          name: null,
          avatarUrl: null,
        })),
    ),
    proxySdp: jest.fn(async (target: string) => {
      const m = target.match(/^\/(.+)\/whip$/);
      if (m) live.add(m[1]);
      return "answer-sdp";
    }),
    getPathStatus: jest.fn(async (path: string) => ({ ready: live.has(path) })),
    kickPath: jest.fn(async (path: string) => {
      live.delete(path);
    }),
  };
  const chat = {
    canAccessTournamentChat: jest.fn(
      async (tid: string, sid: string) => !!access.get(tid)?.has(String(sid)),
    ),
    to: jest.fn(async () => undefined),
  };
  const hasura = {
    query: jest.fn(async (q: any, asSteamId?: string) => {
      if (q.tournaments_by_pk) {
        return {
          tournaments_by_pk: tournaments[q.tournaments_by_pk.__args.id] ?? null,
        };
      }
      if (q.players_by_pk) {
        return {
          players_by_pk: {
            name: "Name",
            avatar_url: null,
            custom_avatar_url: null,
          },
        };
      }
      if (q.tournaments) {
        const tid = q.tournaments.__args.where.id._eq;
        const isOrganizer = !!asSteamId && organizers.get(tid)?.has(asSteamId);
        return { tournaments: isOrganizer ? [{ id: tid }] : [] };
      }
      return {};
    }),
  };
  const redis = fakeRedis();
  const service = new TournamentCallService(
    { warn: jest.fn(), log: jest.fn() } as any,
    hasura as any,
    { getConnection: () => redis } as any,
    chat as any,
    media as any,
  );

  const grant = (tid: string, ...ids: string[]) =>
    ids.forEach((id) => access.get(tid)!.add(id));

  // join + publish, like the popout does
  const joinAndPublish = async (tid: string, u: User) => {
    const { token } = await service.join(tid, u);
    await service.proxyWhip(token, "offer-sdp");
    return token;
  };

  return {
    service,
    media,
    chat,
    hasura,
    redis,
    live,
    access,
    organizers,
    tournaments,
    grant,
    joinAndPublish,
  };
}

describe("TournamentCallService - access", () => {
  it("lets a participant (tournament chat access) join", async () => {
    const t = setup();
    t.grant(T1, "1");
    const result = await t.service.join(T1, user("1"));
    expect(result.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.max).toBe(5);
    expect(t.chat.canAccessTournamentChat).toHaveBeenCalledWith(T1, "1");
  });

  it("lets an assigned organizer and an administrator join (both have chat access)", async () => {
    const t = setup();
    t.grant(T1, "org", "admin");
    await expect(
      t.service.join(T1, user("org", "tournament_organizer")),
    ).resolves.toBeTruthy();
    await expect(
      t.service.join(T1, user("admin", "administrator")),
    ).resolves.toBeTruthy();
  });

  it("rejects an unrelated verified user and an unrelated moderator", async () => {
    const t = setup();
    await expect(t.service.join(T1, user("x"))).rejects.toBeInstanceOf(
      TournamentCallError,
    );
    await expect(
      t.service.join(T1, user("mod", "moderator")),
    ).rejects.toBeInstanceOf(TournamentCallError);
    await expect(
      t.service.getParticipantsForUser(T1, user("mod", "moderator")),
    ).rejects.toBeInstanceOf(TournamentCallError);
    await expect(
      t.service.proxyPeerWhep(T1, "1", user("x"), "sdp"),
    ).rejects.toBeInstanceOf(TournamentCallError);
  });

  it("follows the tournament chat lifecycle: open until 24h after Finished", async () => {
    const t = setup();
    t.grant(T1, "1");
    t.tournaments[T1] = {
      status: "Finished",
      finished_at: new Date(Date.now() - 23 * 3600_000).toISOString(),
    };
    await expect(t.service.join(T1, user("1"))).resolves.toBeTruthy();
    t.tournaments[T1].finished_at = new Date(
      Date.now() - 25 * 3600_000,
    ).toISOString();
    await expect(t.service.join(T1, user("1"))).rejects.toBeInstanceOf(
      TournamentCallError,
    );
    t.tournaments[T1] = { status: "Cancelled", finished_at: null };
    await expect(t.service.join(T1, user("1"))).rejects.toBeInstanceOf(
      TournamentCallError,
    );
  });

  it("invalidates a token once access is lost", async () => {
    const t = setup();
    t.grant(T1, "1");
    const { token } = await t.service.join(T1, user("1"));
    t.access.get(T1)!.delete("1");
    await expect(t.service.proxyWhip(token, "sdp")).rejects.toThrow(
      /invalid or expired/,
    );
    await expect(t.service.getParticipantsForToken(token)).resolves.toEqual([]);
  });
});

describe("TournamentCallService - capacity (max 5)", () => {
  it("users 1-5 can join and publish, user 6 is rejected with a friendly message", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6");
    for (const id of ["1", "2", "3", "4", "5"]) {
      await t.joinAndPublish(T1, user(id));
    }
    expect(await t.service.getParticipants(T1)).toHaveLength(5);
    await expect(t.service.join(T1, user("6"))).rejects.toThrow(
      TOURNAMENT_CALL_FULL_MESSAGE,
    );
    expect(TOURNAMENT_CALL_FULL_MESSAGE).toBe("Webcam room is full (5/5).");
  });

  it("counts people still joining (reserved, camera not live yet) toward the cap", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6");
    for (const id of ["1", "2", "3", "4", "5"])
      await t.service.join(T1, user(id));
    await expect(t.service.join(T1, user("6"))).rejects.toThrow(
      TOURNAMENT_CALL_FULL_MESSAGE,
    );
  });

  it("re-checks the cap at publish time", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6");
    const { token } = await t.service.join(T1, user("6"));
    // 6's reservation lapses while they sit on the device picker...
    t.redis.hashes.get(`tournament-call:reserve:${T1}`)!.delete("6");
    for (const id of ["1", "2", "3", "4", "5"])
      await t.joinAndPublish(T1, user(id));
    await expect(t.service.proxyWhip(token, "sdp")).rejects.toThrow(
      TOURNAMENT_CALL_FULL_MESSAGE,
    );
    expect(t.live.has(TournamentCallService.pathFor(T1, "6"))).toBe(false);
  });

  it("an existing participant re-joining does not need a new slot", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5");
    for (const id of ["1", "2", "3", "4", "5"])
      await t.joinAndPublish(T1, user(id));
    await expect(t.service.join(T1, user("3"))).resolves.toBeTruthy();
  });

  it("leaving frees a slot", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6");
    const tokens: Record<string, string> = {};
    for (const id of ["1", "2", "3", "4", "5"])
      tokens[id] = await t.joinAndPublish(T1, user(id));
    await t.service.hangupForToken(tokens["2"]);
    expect(await t.service.getParticipants(T1)).toHaveLength(4);
    await expect(t.joinAndPublish(T1, user("6"))).resolves.toBeTruthy();
  });

  it("a dropped connection (mediamtx path gone) frees a slot", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6");
    for (const id of ["1", "2", "3", "4", "5"])
      await t.joinAndPublish(T1, user(id));
    // Any participant listing while "4" is live releases their join-time
    // reservation (mediamtx presence counts them from then on).
    await t.service.getParticipants(T1);
    expect(t.redis.hashes.get(`tournament-call:reserve:${T1}`)!.has("4")).toBe(
      false,
    );
    // Browser closed: mediamtx drops the publisher, slot is free at once.
    t.live.delete(TournamentCallService.pathFor(T1, "4"));
    expect(await t.service.getParticipants(T1)).toHaveLength(4);
    await expect(t.joinAndPublish(T1, user("6"))).resolves.toBeTruthy();
  });

  it("rooms are per tournament", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5");
    t.grant(T2, "9");
    for (const id of ["1", "2", "3", "4", "5"])
      await t.joinAndPublish(T1, user(id));
    await expect(t.joinAndPublish(T2, user("9"))).resolves.toBeTruthy();
    expect(await t.service.getParticipants(T2)).toEqual([
      expect.objectContaining({ steamId: "9" }),
    ]);
  });

  it("the Lua reservation script counts live U reserved, excluding self, then reserves", async () => {
    const t = setup();
    t.grant(T1, "1");
    await t.service.join(T1, user("1"));
    const [script, numKeys, key, , , max, self] = t.redis.eval.mock.calls[0];
    expect(numKeys).toBe(1);
    expect(key).toBe(`tournament-call:reserve:${T1}`);
    expect(max).toBe("5");
    expect(self).toBe("1");
    expect(script).toContain("HGETALL");
    expect(script).toContain("if count >= max then return 0 end");
    expect(script).toContain("redis.call('HSET', KEYS[1], self, expiresAt)");
  });
});

describe("TournamentCallService - kick", () => {
  async function roomWithTarget() {
    const t = setup();
    t.grant(T1, "target", "player", "org1", "admin", "mod");
    t.grant(T2, "org2");
    t.organizers.get(T1)!.add("org1");
    t.organizers.get(T2)!.add("org2");
    await t.joinAndPublish(T1, user("target"));
    return t;
  }

  it("an administrator can kick", async () => {
    const t = await roomWithTarget();
    await t.service.kick(T1, "target", user("admin", "administrator"));
    expect(t.live.has(TournamentCallService.pathFor(T1, "target"))).toBe(false);
  });

  it("an organizer assigned to THIS tournament can kick", async () => {
    const t = await roomWithTarget();
    await t.service.kick(T1, "target", user("org1", "tournament_organizer"));
    expect(t.live.has(TournamentCallService.pathFor(T1, "target"))).toBe(false);
  });

  it.each([
    [
      "an organizer of another tournament",
      user("org2", "tournament_organizer"),
    ],
    ["a moderator", user("mod", "moderator")],
    ["an ordinary player", user("player")],
  ])("%s cannot kick", async (_label, actor) => {
    const t = await roomWithTarget();
    await expect(t.service.kick(T1, "target", actor)).rejects.toBeInstanceOf(
      TournamentCallError,
    );
    expect(t.live.has(TournamentCallService.pathFor(T1, "target"))).toBe(true);
    expect(t.media.kickPath).not.toHaveBeenCalled();
  });

  it("kick frees the slot, only touches the webcam room, and allows rejoining", async () => {
    const t = setup();
    t.grant(T1, "1", "2", "3", "4", "5", "6", "admin");
    const tokens: Record<string, string> = {};
    for (const id of ["1", "2", "3", "4", "5"])
      tokens[id] = await t.joinAndPublish(T1, user(id));
    await t.service.kick(T1, "3", user("admin", "administrator"));

    expect(await t.service.getParticipants(T1)).toHaveLength(4);
    await expect(t.joinAndPublish(T1, user("6"))).resolves.toBeTruthy();
    // The kicked player's old link is dead...
    await expect(t.service.proxyWhip(tokens["3"], "sdp")).rejects.toThrow(
      /invalid or expired/,
    );
    // ...but their eligibility is untouched (chat access still granted).
    expect(t.access.get(T1)!.has("3")).toBe(true);
    // The only broadcast is webcam presence on the tournament channel.
    expect(t.chat.to).toHaveBeenCalledWith(
      ChatLobbyType.Tournament,
      T1,
      "call-left",
      expect.objectContaining({ steamId: "3", kicked: true }),
    );
  });

  it("canKick reports the right answer for the UI", async () => {
    const t = await roomWithTarget();
    await expect(
      t.service.canKick(T1, user("admin", "administrator")),
    ).resolves.toBe(true);
    await expect(
      t.service.canKick(T1, user("org1", "tournament_organizer")),
    ).resolves.toBe(true);
    await expect(
      t.service.canKick(T1, user("org2", "tournament_organizer")),
    ).resolves.toBe(false);
    await expect(t.service.canKick(T1, user("mod", "moderator"))).resolves.toBe(
      false,
    );
    await expect(t.service.canKick(T1, user("player"))).resolves.toBe(false);
  });
});

describe("TournamentCallService - presence and notifications", () => {
  it("participants who lost access are removed and no longer hold a slot", async () => {
    const t = setup();
    t.grant(T1, "1", "2");
    await t.joinAndPublish(T1, user("1"));
    await t.joinAndPublish(T1, user("2"));
    t.access.get(T1)!.delete("2");
    const participants = await t.service.getParticipants(T1);
    expect(participants.map((p) => p.steamId)).toEqual(["1"]);
    expect(t.live.has(TournamentCallService.pathFor(T1, "2"))).toBe(false);
  });

  it("joining only emits webcam presence events on the tournament channel (no ring/push)", async () => {
    const t = setup();
    t.grant(T1, "1");
    await t.joinAndPublish(T1, user("1"));
    await new Promise((r) => setImmediate(r));
    const events = t.chat.to.mock.calls.map((c: any[]) => [c[0], c[2]]);
    expect(events).toEqual([
      [ChatLobbyType.Tournament, "call-joining"],
      [ChatLobbyType.Tournament, "call-joined"],
    ]);
  });

  it("has no notification or push dependency at all", () => {
    const fs = require("fs");
    const src: string = fs.readFileSync(
      require.resolve("./tournament-call.service"),
      "utf8",
    );
    expect(src).not.toMatch(
      /NotificationsService|PushService|sendPush|notifyPlayers/,
    );
    expect(src).not.toMatch(/ChatLobbyType\.MatchMaking/);
  });
});
