import {
  AUTO_STREAM_MATCH_STATUSES,
  MAX_MATCHES_PER_REQUEST,
  parseMatchIds,
  TwitchStreamsService,
} from "./twitch-streams.service";
import { TwitchChannelStatus, TWITCH_COUNTER_STRIKE_GAME_ID } from "./twitch.service";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const VIEWER = "76561190000000001";

const status = (channel: string, over: Partial<TwitchChannelStatus> = {}): TwitchChannelStatus => ({
  channel,
  live: true,
  available: true,
  streamId: `s-${channel}`,
  gameId: TWITCH_COUNTER_STRIKE_GAME_ID,
  gameName: "Counter-Strike",
  title: `${channel} live`,
  checkedAt: "2026-10-04T00:00:00.000Z",
  ...over,
});

const seat = (match_id: string, steam_id: string, name: string, twitch_channel: string) => ({
  match_id,
  steam_id,
  name,
  avatar_url: `https://avatars/${steam_id}.jpg`,
  twitch_channel,
});

describe("TwitchStreamsService.getMatchAutoStreams", () => {
  let postgres: { query: jest.Mock };
  let twitch: { getStatuses: jest.Mock; getStatus: jest.Mock };
  let service: TwitchStreamsService;

  beforeEach(() => {
    postgres = { query: jest.fn() };
    twitch = { getStatuses: jest.fn(), getStatus: jest.fn() };
    service = new TwitchStreamsService(postgres as any, twitch as any);
  });

  // Route the two SQL queries by their text.
  function db(opts: { blocked?: string[]; seated?: any[] }) {
    postgres.query.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes("coach_steam_id")) {
        return (opts.blocked ?? []).filter((id) => params[0].includes(id)).map((id) => ({ id }));
      }
      if (sql.includes("twitch_channel IS NOT NULL")) {
        expect(params[1]).toEqual(AUTO_STREAM_MATCH_STATUSES);
        return (opts.seated ?? []).filter((row) => params[0].includes(row.match_id));
      }
      throw new Error(`unexpected sql ${sql}`);
    });
  }

  it("seated player live in CS2 => attached to their live match", async () => {
    db({ seated: [seat(M1, "1", "TricoN", "tricon")] });
    twitch.getStatuses.mockResolvedValue({ tricon: status("tricon") });
    const result = await service.getMatchAutoStreams([M1], null);
    expect(result[M1]).toEqual([
      {
        matchId: M1,
        steamId: "1",
        playerName: "TricoN",
        avatarUrl: "https://avatars/1.jpg",
        channel: "tricon",
        link: "https://www.twitch.tv/tricon",
        title: "tricon live",
        gameName: "Counter-Strike",
      },
    ]);
  });

  it("player offline => not shown", async () => {
    db({ seated: [seat(M1, "1", "TricoN", "tricon")] });
    twitch.getStatuses.mockResolvedValue({ tricon: status("tricon", { live: false, gameId: null, gameName: null }) });
    expect((await service.getMatchAutoStreams([M1], null))[M1]).toEqual([]);
  });

  it("live but streaming another game => not attached to the match", async () => {
    db({ seated: [seat(M1, "1", "TricoN", "tricon")] });
    twitch.getStatuses.mockResolvedValue({
      tricon: status("tricon", { gameId: "509658", gameName: "Just Chatting" }),
    });
    expect((await service.getMatchAutoStreams([M1], null))[M1]).toEqual([]);
  });

  it("Twitch unavailable => nothing attached", async () => {
    db({ seated: [seat(M1, "1", "TricoN", "tricon")] });
    twitch.getStatuses.mockResolvedValue({ tricon: status("tricon", { live: false, available: false }) });
    expect((await service.getMatchAutoStreams([M1], null))[M1]).toEqual([]);
  });

  it("only seated lineup players of a Live match are considered (the SQL decides)", async () => {
    db({ seated: [] });
    twitch.getStatuses.mockResolvedValue({});
    const result = await service.getMatchAutoStreams([M1], null);
    expect(result[M1]).toEqual([]);
    const seatedSql = postgres.query.mock.calls.find(([sql]) => sql.includes("twitch_channel IS NOT NULL"))[0];
    expect(seatedSql).toContain("match_lineup_players");
    expect(seatedSql).toContain("IN (m.lineup_1_id, m.lineup_2_id)");
    expect(seatedSql).toContain("m.status = ANY($2::text[])");
    expect(AUTO_STREAM_MATCH_STATUSES).toEqual(["Live"]); // finished/check-in/veto excluded
    // Actual gameplay only: Live is not enough while the server is still
    // missing or booting (test/players-twitch-channel.spec.ts runs it).
    expect(seatedSql).toContain("m.server_id IS NOT NULL");
    expect(seatedSql).toContain("public.is_server_online(m) IS TRUE");
    expect(twitch.getStatuses).not.toHaveBeenCalled();
  });

  it("a player or coach of the match gets nothing for that match (anti-cheat)", async () => {
    db({
      blocked: [M1],
      seated: [seat(M1, "1", "TricoN", "tricon"), seat(M2, "2", "Theft", "theft")],
    });
    twitch.getStatuses.mockResolvedValue({ tricon: status("tricon"), theft: status("theft") });
    const result = await service.getMatchAutoStreams([M1, M2], VIEWER);
    expect(result[M1]).toEqual([]);
    expect(result[M2].map((s) => s.channel)).toEqual(["theft"]);
    const blockSql = postgres.query.mock.calls.find(([sql]) => sql.includes("coach_steam_id"));
    expect(blockSql[0]).toContain("match_lineup_players");
    expect(blockSql[1]).toEqual([[M1, M2], VIEWER]);
  });

  it("guests are never treated as participants", async () => {
    db({ seated: [seat(M1, "1", "TricoN", "tricon")] });
    twitch.getStatuses.mockResolvedValue({ tricon: status("tricon") });
    await service.getMatchAutoStreams([M1], null);
    expect(postgres.query.mock.calls.some(([sql]) => sql.includes("coach_steam_id"))).toBe(false);
  });

  it("batches every seated channel into one status lookup", async () => {
    db({
      seated: [seat(M1, "1", "A", "aaaa"), seat(M1, "2", "B", "bbbb"), seat(M2, "3", "C", "cccc")],
    });
    twitch.getStatuses.mockResolvedValue({ aaaa: status("aaaa"), bbbb: status("bbbb"), cccc: status("cccc") });
    const result = await service.getMatchAutoStreams([M1, M2], null);
    expect(twitch.getStatuses).toHaveBeenCalledTimes(1);
    expect(twitch.getStatuses).toHaveBeenCalledWith(["aaaa", "bbbb", "cccc"]);
    expect(result[M1].map((s) => s.channel)).toEqual(["aaaa", "bbbb"]);
    expect(result[M2].map((s) => s.channel)).toEqual(["cccc"]);
  });

  it("the same channel is listed once per match", async () => {
    db({ seated: [seat(M1, "1", "A", "aaaa"), seat(M1, "1", "A", "aaaa")] });
    twitch.getStatuses.mockResolvedValue({ aaaa: status("aaaa") });
    expect((await service.getMatchAutoStreams([M1], null))[M1]).toHaveLength(1);
  });

  it("no match ids => no queries", async () => {
    expect(await service.getMatchAutoStreams([], VIEWER)).toEqual({});
    expect(postgres.query).not.toHaveBeenCalled();
  });
});

describe("TwitchStreamsService player channel", () => {
  let postgres: { query: jest.Mock };
  let twitch: { getStatuses: jest.Mock; getStatus: jest.Mock };
  let service: TwitchStreamsService;

  beforeEach(() => {
    postgres = { query: jest.fn() };
    twitch = { getStatuses: jest.fn(), getStatus: jest.fn() };
    service = new TwitchStreamsService(postgres as any, twitch as any);
  });

  it("profile: live in any game shows live (green dot is not CS2-only)", async () => {
    postgres.query.mockResolvedValue([{ twitch_channel: "tricon" }]);
    twitch.getStatus.mockResolvedValue(status("tricon", { gameId: "509658", gameName: "Just Chatting" }));
    expect(await service.getPlayerTwitch("76561190000000002")).toMatchObject({
      channel: "tricon",
      live: true,
      gameName: "Just Chatting",
    });
  });

  it("profile: offline, no channel, unknown player, bad id", async () => {
    postgres.query.mockResolvedValueOnce([{ twitch_channel: "tricon" }]);
    twitch.getStatus.mockResolvedValue(status("tricon", { live: false }));
    expect((await service.getPlayerTwitch("1")).live).toBe(false);

    postgres.query.mockResolvedValueOnce([{ twitch_channel: null }]);
    expect(await service.getPlayerTwitch("1")).toMatchObject({ channel: null, live: false });

    postgres.query.mockResolvedValueOnce([]);
    expect(await service.getPlayerTwitch("1")).toBeNull();

    postgres.query.mockClear();
    expect(await service.getPlayerTwitch("1 OR 1=1")).toBeNull();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("setOwnChannel normalizes and only updates the given (session) player", async () => {
    postgres.query.mockResolvedValue([]);
    expect(await service.setOwnChannel("42", "https://www.twitch.tv/TricoN/")).toEqual({ ok: true, channel: "tricon" });
    expect(postgres.query).toHaveBeenCalledWith(expect.stringContaining("WHERE steam_id = $1::bigint"), ["42", "tricon"]);
  });

  it("setOwnChannel clears, and rejects invalid input without touching the DB", async () => {
    postgres.query.mockResolvedValue([]);
    expect(await service.setOwnChannel("42", "")).toEqual({ ok: true, channel: null });
    expect(postgres.query).toHaveBeenLastCalledWith(expect.any(String), ["42", null]);

    postgres.query.mockClear();
    expect(await service.setOwnChannel("42", "https://clips.twitch.tv/abc")).toEqual({ ok: false, error: "unsupported_url" });
    expect(await service.setOwnChannel("42", { channel: "x" })).toEqual({ ok: false, error: "invalid_channel" });
    expect(postgres.query).not.toHaveBeenCalled();
  });
});

describe("parseMatchIds", () => {
  it("keeps valid, unique, lowercased UUIDs and caps the count", () => {
    expect(parseMatchIds(`${M1.toUpperCase()},${M1},nope, ${M2}`)).toEqual([M1, M2]);
    expect(parseMatchIds([M1, M2])).toEqual([M1, M2]);
    expect(parseMatchIds(undefined)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseMatchIds(many.join(","))).toHaveLength(MAX_MATCHES_PER_REQUEST);
  });
});
