import { Logger } from "@nestjs/common";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { getMatchmakingLobbyDetailsCacheKey } from "./utilities/cacheKeys";

function build(details?: object) {
  const hashes = new Map<string, Record<string, string>>();
  if (details) {
    hashes.set(getMatchmakingLobbyDetailsCacheKey("lobby-1"), {
      details: JSON.stringify(details),
    });
  }
  const published: Array<{ steamId: string; event: string; data: any }> = [];
  const redis: any = {
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hset: jest.fn(),
    hdel: jest.fn(),
    // The lobby is in the queue at position 0.
    zrank: jest.fn().mockResolvedValue(0),
    zrem: jest.fn(),
    publish: jest.fn(async (_channel: string, payload: string) => {
      published.push(JSON.parse(payload));
      return 1;
    }),
  };

  const service = new MatchmakingLobbyService(
    new Logger("test"),
    {} as any,
    { getConnection: () => redis } as any,
    {} as any,
    {} as any,
  );

  return { service, published };
}

const lobby = {
  type: "Competitive",
  regions: ["Europe"],
  joinedAt: "2026-10-04T00:00:00.000Z",
  lobbyId: "lobby-1",
  players: [{ steam_id: "1", rank: 5000 }],
  avgRank: 5000,
};

describe("queue details carry the server clock", () => {
  it("sends serverNow next to joinedAt so the search timer can start at 0", async () => {
    const { service, published } = build(lobby);
    const before = Date.now();

    await service.sendQueueDetailsToLobby("lobby-1");

    const sent = published.find((m) => m.event === "matchmaking:details");
    expect(sent?.data.details.joinedAt).toBe(lobby.joinedAt);
    const serverNow = Date.parse(sent!.data.details.serverNow);
    expect(serverNow).toBeGreaterThanOrEqual(before);
    expect(serverNow).toBeLessThanOrEqual(Date.now());
  });

  it("sends no details (so nobody looks queued) when the lobby is gone", async () => {
    const { service, published } = build();

    await service.sendQueueDetailsToLobby("lobby-1");

    expect(published).toEqual([]);
  });
});
