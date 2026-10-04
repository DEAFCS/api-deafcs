import {
  isCounterStrikeStream,
  TwitchChannelStatus,
  TwitchService,
  TWITCH_COUNTER_STRIKE_GAME_ID,
} from "./twitch.service";

// Fake credentials: never real, only used to prove they never leak.
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret-should-never-leak";
const TOKEN = "test-app-token-should-never-leak";

class FakeCache {
  public store = new Map<string, { value: any; ttl?: number }>();
  async get(key: string) {
    return this.store.get(key)?.value;
  }
  async put(key: string, value: any, seconds?: number) {
    this.store.set(key, { value: JSON.parse(JSON.stringify(value)), ttl: seconds });
    return true;
  }
}

function config(twitch: Record<string, string | undefined>) {
  return { get: (key: string) => (key === "twitch" ? twitch : undefined) } as any;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const liveStream = (login: string, gameId = TWITCH_COUNTER_STRIKE_GAME_ID, gameName = "Counter-Strike") => ({
  id: `stream-${login}`,
  user_login: login,
  game_id: gameId,
  game_name: gameName,
  type: "live",
  title: `${login} playing`,
});

describe("TwitchService", () => {
  let cache: FakeCache;
  let logger: { warn: jest.Mock; error: jest.Mock; log: jest.Mock };
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    cache = new FakeCache();
    logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  const make = (creds = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }) =>
    new TwitchService(config(creds), cache as any, logger as any);

  function routeTwitch(streams: any[] | ((url: string) => any)) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
        return jsonResponse(200, { access_token: TOKEN, expires_in: 3600 });
      }
      if (url.startsWith("https://api.twitch.tv/helix/streams")) {
        expect(init.headers["Client-Id"]).toBe(CLIENT_ID);
        expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        const data = typeof streams === "function" ? streams(url) : streams;
        return jsonResponse(200, { data });
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it("gets an app token with client credentials in the POST body, not the URL", async () => {
    routeTwitch([]);
    await make().getStatuses(["tricon"]);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://id.twitch.tv/oauth2/token");
    expect(tokenUrl).not.toContain(CLIENT_SECRET);
    expect(tokenInit.method).toBe("POST");
    expect(String(tokenInit.body)).toContain("grant_type=client_credentials");
  });

  it("reports live (with game and title) and offline channels", async () => {
    routeTwitch([liveStream("tricon")]);
    const statuses = await make().getStatuses(["TricoN", "theft"]);
    expect(statuses.tricon).toMatchObject({
      channel: "tricon",
      live: true,
      available: true,
      streamId: "stream-tricon",
      gameId: TWITCH_COUNTER_STRIKE_GAME_ID,
      gameName: "Counter-Strike",
      title: "tricon playing",
    });
    expect(statuses.theft).toMatchObject({ channel: "theft", live: false, available: true, streamId: null });
    expect(typeof statuses.tricon.checkedAt).toBe("string");
  });

  it("batches every uncached channel into one Helix request and reuses the token", async () => {
    routeTwitch([]);
    const service = make();
    await service.getStatuses(["aaaa", "bbbb", "cccc"]);
    const helix = fetchMock.mock.calls.filter(([u]) => u.startsWith("https://api.twitch.tv"));
    expect(helix).toHaveLength(1);
    expect(helix[0][0]).toContain("user_login=aaaa&user_login=bbbb&user_login=cccc");

    await service.getStatuses(["dddd"]);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => u.startsWith("https://id.twitch.tv"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("serves repeat lookups from the cache and only asks Twitch for the rest", async () => {
    routeTwitch([liveStream("tricon")]);
    const service = make();
    await service.getStatuses(["tricon"]);
    expect(cache.store.get(TwitchService.cacheKey("tricon"))?.ttl).toBe(TwitchService.STATUS_TTL_SECONDS);

    fetchMock.mockClear();
    routeTwitch([]);
    const second = await service.getStatuses(["tricon", "theft"]);
    expect(second.tricon.live).toBe(true);
    const helix = fetchMock.mock.calls.filter(([u]) => u.startsWith("https://api.twitch.tv"));
    expect(helix).toHaveLength(1);
    expect(helix[0][0]).toContain("user_login=theft");
    expect(helix[0][0]).not.toContain("user_login=tricon");
  });

  it("asks Twitch again once the cached entry has expired", async () => {
    routeTwitch([liveStream("tricon")]);
    const service = make();
    await service.getStatuses(["tricon"]);
    cache.store.delete(TwitchService.cacheKey("tricon")); // TTL elapsed
    routeTwitch([]);
    const later = await service.getStatuses(["tricon"]);
    expect(later.tricon.live).toBe(false);
  });

  it("ignores invalid channel names entirely", async () => {
    routeTwitch([]);
    const statuses = await make().getStatuses(["no", "bad name", "https://x.y/z"]);
    expect(statuses).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing credentials: unavailable, no network, nothing cached", async () => {
    const service = make({ clientId: undefined as any, clientSecret: undefined as any });
    expect(service.isConfigured()).toBe(false);
    const statuses = await service.getStatuses(["tricon"]);
    expect(statuses.tricon).toMatchObject({ live: false, available: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it("Twitch errors fail safely (unavailable, short cache) and never leak secrets to logs", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://id.twitch.tv")) {
        return jsonResponse(200, { access_token: TOKEN, expires_in: 3600 });
      }
      return jsonResponse(500, { message: "boom" });
    });
    const statuses = await make().getStatuses(["tricon"]);
    expect(statuses.tricon).toMatchObject({ live: false, available: false });
    expect(cache.store.get(TwitchService.cacheKey("tricon"))?.ttl).toBe(TwitchService.ERROR_TTL_SECONDS);
    const logged = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain(TOKEN);
  });

  it("a network exception is also unavailable, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error(`socket hang up ${CLIENT_SECRET}`));
    const statuses = await make().getStatuses(["tricon"]);
    expect(statuses.tricon).toMatchObject({ live: false, available: false });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("refreshes an expired/revoked token once on 401", async () => {
    let helixCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://id.twitch.tv")) {
        return jsonResponse(200, { access_token: TOKEN, expires_in: 3600 });
      }
      helixCalls++;
      return helixCalls === 1 ? jsonResponse(401, {}) : jsonResponse(200, { data: [liveStream("tricon")] });
    });
    const statuses = await make().getStatuses(["tricon"]);
    expect(statuses.tricon.live).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => u.startsWith("https://id.twitch.tv"))).toHaveLength(2);
  });

  it("returned statuses never contain credentials or the token", async () => {
    routeTwitch([liveStream("tricon")]);
    const statuses = await make().getStatuses(["tricon", "theft"]);
    const text = JSON.stringify(statuses) + JSON.stringify([...cache.store.values()]);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CLIENT_ID);
  });
});

describe("isCounterStrikeStream", () => {
  const status = (over: Partial<TwitchChannelStatus>): TwitchChannelStatus => ({
    channel: "x",
    live: true,
    available: true,
    streamId: "1",
    gameId: null,
    gameName: null,
    title: null,
    checkedAt: "",
    ...over,
  });

  it("accepts the Counter-Strike category by id or name", () => {
    expect(isCounterStrikeStream(status({ gameId: TWITCH_COUNTER_STRIKE_GAME_ID }))).toBe(true);
    expect(isCounterStrikeStream(status({ gameName: "Counter-Strike" }))).toBe(true);
    expect(isCounterStrikeStream(status({ gameName: "Counter-Strike 2" }))).toBe(true);
  });

  it("rejects other games and offline channels", () => {
    expect(isCounterStrikeStream(status({ gameId: "21779", gameName: "League of Legends" }))).toBe(false);
    expect(isCounterStrikeStream(status({ gameName: "Just Chatting" }))).toBe(false);
    expect(isCounterStrikeStream(status({ live: false, gameId: TWITCH_COUNTER_STRIKE_GAME_ID }))).toBe(false);
  });
});
