import { FaceitService, latestCompletedFaceitMatchAt } from "./faceit.service";

describe("FaceitService leaderboard cache", () => {
  const steamId = "76561198000000001";
  const playerId = "faceit-player-1";

  const createService = () => {
    const cache = {
      has: jest.fn().mockResolvedValue(false),
      put: jest.fn().mockResolvedValue(undefined),
    };
    const hasura = { query: jest.fn() };
    const postgres = { query: jest.fn().mockResolvedValue([]) };
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
    };
    const config = { get: jest.fn().mockReturnValue("server-side-key") };
    const service = new FaceitService(
      config as never,
      cache as never,
      hasura as never,
      postgres as never,
      logger as never,
    );
    return { service, cache, hasura, postgres, logger };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("selects the newest completed FACEIT match timestamp", () => {
    expect(
      latestCompletedFaceitMatchAt([
        { finished_at: 1_700_000_000, status: "FINISHED" },
        { finished_at: 1_800_000_000, status: "ONGOING" },
        { finished_at: 1_750_000_000 },
      ]),
    ).toBe(new Date(1_750_000_000 * 1000).toISOString());
  });

  it("caches rating, level and the official completed-match timestamp", async () => {
    const { service, postgres } = createService();
    const finishedAt = 1_750_000_000;
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            player_id: playerId,
            nickname: "Player",
            faceit_url: "https://faceit.test/{lang}/players/Player",
            games: { cs2: { skill_level: 10, faceit_elo: 2593 } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ finished_at: finishedAt, status: "FINISHED" }],
          }),
          { status: 200 },
        ),
      );

    await expect(service.refreshPlayer(steamId)).resolves.toBe(true);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("faceit_last_match_at = CASE"),
      [
        steamId,
        playerId,
        "Player",
        10,
        2593,
        "https://faceit.test/en/players/Player",
        new Date(finishedAt * 1000).toISOString(),
        true,
      ],
    );
    expect(postgres.query.mock.calls[0][0]).toContain(
      "faceit_updated_at = now()",
    );
    expect(postgres.query.mock.calls[0][0]).not.toContain(
      "faceit_refresh_attempted_at",
    );
  });

  it("does not overwrite cached database data when the profile API fails", async () => {
    const { service, postgres } = createService();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(service.refreshPlayer(steamId)).resolves.toBe(false);
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("caches a missing FACEIT account without clearing cached database data", async () => {
    const { service, cache, postgres } = createService();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(service.refreshPlayer(steamId)).resolves.toBe(false);

    expect(postgres.query).not.toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalledWith(
      `faceit:no-account:cs2:${steamId}`,
      true,
      12 * 60 * 60,
    );
  });

  it("preserves the cached match timestamp when only history is unavailable", async () => {
    const { service, postgres } = createService();
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            player_id: playerId,
            nickname: "Player",
            games: { cs2: { skill_level: 9, faceit_elo: 2200 } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

    await expect(service.refreshPlayer(steamId)).resolves.toBe(true);
    expect(postgres.query).toHaveBeenCalledWith(expect.any(String), [
      steamId,
      playerId,
      "Player",
      9,
      2200,
      null,
      null,
      false,
    ]);
  });

  it("records a cached missing-account attempt without touching cached FACEIT data", async () => {
    const { service, cache, postgres } = createService();
    postgres.query
      .mockResolvedValueOnce([{ steam_id: steamId }])
      .mockResolvedValueOnce([]);
    cache.has.mockResolvedValueOnce(true);
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(service.refreshVerifiedPlayers()).resolves.toEqual({
      eligible: 1,
      refreshed: 0,
      skipped: 1,
      failed: 0,
    });

    expect(postgres.query).toHaveBeenCalledTimes(2);
    expect(postgres.query.mock.calls[1]).toEqual([
      expect.stringContaining("SET faceit_refresh_attempted_at = now()"),
      [steamId],
    ]);
    expect(postgres.query.mock.calls[1][0]).not.toContain("faceit_updated_at");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("limits fair refresh batches to 100 players with concurrency 2", async () => {
    const { service, postgres } = createService();
    const players = Array.from({ length: 150 }, (_, index) => ({
      steam_id: String(76561198000001000n + BigInt(index)),
    }));
    postgres.query.mockResolvedValueOnce(players).mockResolvedValue([]);

    let active = 0;
    let maxActive = 0;
    const refresh = jest
      .spyOn(service, "refreshPlayer")
      .mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return false;
      });

    await expect(service.refreshVerifiedPlayers()).resolves.toEqual({
      eligible: 100,
      refreshed: 0,
      skipped: 100,
      failed: 0,
    });

    expect(refresh).toHaveBeenCalledTimes(100);
    expect(maxActive).toBe(2);
    expect(postgres.query).toHaveBeenCalledTimes(101);
    expect(postgres.query.mock.calls[0][0]).toContain(
      "faceit_refresh_attempted_at IS NULL",
    );
    expect(postgres.query.mock.calls[0][0]).toContain(
      "ORDER BY faceit_refresh_attempted_at ASC NULLS FIRST",
    );
    expect(postgres.query.mock.calls[0][1]).toEqual([
      [
        "verified_user",
        "streamer",
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ],
      6,
      45,
      100,
    ]);
  });
});
