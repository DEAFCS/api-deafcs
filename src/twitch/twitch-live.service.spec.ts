import { TwitchChannelStatus, TWITCH_COUNTER_STRIKE_GAME_ID, twitchThumbnail } from "./twitch.service";
import { MAX_LIVE_STREAMERS, TwitchLiveService, VIEWER_ACTIVE_MATCH_STATUSES } from "./twitch-live.service";

const VIEWER = "76561190000000001";

const status = (channel: string, over: Partial<TwitchChannelStatus> = {}): TwitchChannelStatus => ({
  channel,
  live: true,
  available: true,
  streamId: `s-${channel}`,
  gameId: TWITCH_COUNTER_STRIKE_GAME_ID,
  gameName: "Counter-Strike",
  title: `${channel} live`,
  viewerCount: 10,
  startedAt: "2026-10-20T18:00:00Z",
  thumbnailUrl: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-320x180.jpg`,
  checkedAt: "2026-10-20T19:00:00.000Z",
  ...over,
});

const linked = (steam_id: string, name: string, twitch_channel: string) => ({
  steam_id,
  name,
  avatar_url: `https://avatars/${steam_id}.jpg`,
  twitch_channel,
});

class FakeCache {
  public store = new Map<string, any>();
  async get(key: string) {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  async put(key: string, value: any) {
    this.store.set(key, JSON.stringify(value));
    return true;
  }
  async acquireLock() {
    return "token";
  }
  async releaseLock() {
    return true;
  }
}

describe("TwitchLiveService", () => {
  let postgres: { query: jest.Mock };
  let twitch: { getStatuses: jest.Mock };
  let cache: FakeCache;
  let service: TwitchLiveService;
  let players: any[];
  let inViewerMatch: string[];

  beforeEach(() => {
    players = [];
    inViewerMatch = [];
    postgres = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("twitch_channel IS NOT NULL")) {
          // Banned players are filtered by the SQL itself.
          expect(sql).toContain("public.is_banned(p) IS NOT TRUE");
          return players;
        }
        if (sql.includes("coach_steam_id")) {
          expect(params?.[0]).toBe(VIEWER);
          expect(params?.[1]).toEqual(VIEWER_ACTIVE_MATCH_STATUSES);
          return inViewerMatch.map((steam_id) => ({ steam_id }));
        }
        throw new Error(`unexpected sql ${sql}`);
      }),
    };
    twitch = { getStatuses: jest.fn() };
    cache = new FakeCache();
    service = new TwitchLiveService(postgres as any, twitch as any, cache as any, {
      warn: jest.fn(),
    } as any);
  });

  it("lists linked players live in Counter-Strike, most viewers first", async () => {
    players = [linked("1", "Alpha", "alpha"), linked("2", "Bravo", "bravo"), linked("3", "Charlie", "charlie")];
    twitch.getStatuses.mockResolvedValue({
      alpha: status("alpha", { viewerCount: 5 }),
      bravo: status("bravo", { viewerCount: 50 }),
      charlie: status("charlie", { viewerCount: 12 }),
    });
    const result = await service.getLiveStreamers(null);
    expect(result.available).toBe(true);
    expect(result.streams.map((s) => s.playerName)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(result.streams[0]).toMatchObject({
      steamId: "2",
      channel: "bravo",
      link: "https://www.twitch.tv/bravo",
      viewerCount: 50,
      thumbnailUrl: expect.stringContaining("static-cdn.jtvnw.net"),
    });
  });

  it("offline players and other games are left out", async () => {
    players = [linked("1", "Live", "live"), linked("2", "Offline", "off"), linked("3", "Other", "other")];
    twitch.getStatuses.mockResolvedValue({
      live: status("live"),
      off: status("off", { live: false }),
      other: status("other", { gameId: "509658", gameName: "Just Chatting" }),
    });
    const result = await service.getLiveStreamers(null);
    expect(result.streams.map((s) => s.channel)).toEqual(["live"]);
  });

  it("Twitch unavailable: no streams and available=false (section hidden)", async () => {
    players = [linked("1", "A", "a")];
    twitch.getStatuses.mockResolvedValue({ a: status("a", { live: false, available: false }) });
    const result = await service.getLiveStreamers(null);
    expect(result).toMatchObject({ available: false, streams: [] });
  });

  it("no linked players: nothing asked from Twitch", async () => {
    const result = await service.getLiveStreamers(null);
    expect(result.streams).toEqual([]);
    expect(twitch.getStatuses).not.toHaveBeenCalled();
  });

  it("the list is cached: a second request within the fresh window does not ask Twitch again", async () => {
    players = [linked("1", "A", "a")];
    twitch.getStatuses.mockResolvedValue({ a: status("a") });
    await service.getLiveStreamers(null);
    await service.getLiveStreamers(null);
    expect(twitch.getStatuses).toHaveBeenCalledTimes(1);
  });

  it("anti-cheat: a viewer does not get streams of players in their own ongoing match", async () => {
    players = [linked("1", "Opponent", "opp"), linked("2", "Elsewhere", "else")];
    twitch.getStatuses.mockResolvedValue({ opp: status("opp"), else: status("else") });
    inViewerMatch = ["1"];
    const forViewer = await service.getLiveStreamers(VIEWER);
    expect(forViewer.streams.map((s) => s.channel)).toEqual(["else"]);
    // Guests and other viewers still see everyone (the shared list is not changed).
    const forGuest = await service.getLiveStreamers(null);
    expect(forGuest.streams.map((s) => s.channel).sort()).toEqual(["else", "opp"]);
  });

  it("a malformed viewer id is treated as a guest (no SQL with it)", async () => {
    players = [linked("1", "A", "a")];
    twitch.getStatuses.mockResolvedValue({ a: status("a") });
    await service.getLiveStreamers("1; DROP TABLE players");
    expect(postgres.query.mock.calls.some(([sql]) => sql.includes("coach_steam_id"))).toBe(false);
  });

  it("old cached statuses without the new fields still work (nulls)", async () => {
    players = [linked("1", "A", "a")];
    const legacy = status("a");
    delete legacy.viewerCount;
    delete legacy.startedAt;
    delete legacy.thumbnailUrl;
    twitch.getStatuses.mockResolvedValue({ a: legacy });
    const result = await service.getLiveStreamers(null);
    expect(result.streams[0]).toMatchObject({ viewerCount: null, startedAt: null, thumbnailUrl: null });
  });

  it("caps the list", async () => {
    players = Array.from({ length: MAX_LIVE_STREAMERS + 5 }, (_, i) => linked(String(i), `P${i}`, `p${i}chan`));
    twitch.getStatuses.mockResolvedValue(
      Object.fromEntries(players.map((p, i) => [p.twitch_channel, status(p.twitch_channel, { viewerCount: i })])),
    );
    const result = await service.getLiveStreamers(null);
    expect(result.streams).toHaveLength(MAX_LIVE_STREAMERS);
  });

  it("the response never contains credentials or tokens", async () => {
    players = [linked("1", "A", "a")];
    twitch.getStatuses.mockResolvedValue({ a: status("a") });
    const json = JSON.stringify(await service.getLiveStreamers(null));
    expect(json).not.toMatch(/token|secret|client/i);
  });
});

describe("twitchThumbnail", () => {
  it("sizes Twitch's template and refuses any other host", () => {
    expect(
      twitchThumbnail("https://static-cdn.jtvnw.net/previews-ttv/live_user_x-{width}x{height}.jpg"),
    ).toBe("https://static-cdn.jtvnw.net/previews-ttv/live_user_x-320x180.jpg");
    expect(twitchThumbnail("https://evil.example/x-{width}x{height}.jpg")).toBeNull();
    expect(twitchThumbnail(undefined)).toBeNull();
  });
});
