import { TypeSenseService } from "./type-sense.service";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";

describe("TypeSenseService player ratings", () => {
  const logger = { error: jest.fn() };
  const config = { get: jest.fn(() => ({ apiKey: "test" })) };
  const matchAssistant = { sendServerMatchId: jest.fn() };
  const reindexQueue = { add: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("declares unified rating, role-rank, and match-count fields and schedules one schema refresh", async () => {
    const create = jest.fn();
    const collections = jest.fn((name?: string) => {
      if (name === "players") {
        return { exists: jest.fn().mockResolvedValue(false) };
      }
      return { create };
    });
    const service = new TypeSenseService(
      logger as any,
      config as any,
      {} as any,
      matchAssistant as any,
      reindexQueue as any,
    );
    (service as any).client = { collections };

    await service.createPlayerCollection();

    const schema = create.mock.calls[0][0];
    expect(schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "elo",
          type: "int32",
          optional: true,
          sort: true,
          index: true,
        }),
        expect.objectContaining({
          name: "tournament_elo",
          type: "int32",
          optional: true,
          sort: true,
          index: true,
        }),
        expect.objectContaining({
          name: "total_matches",
          type: "int32",
          optional: true,
          index: true,
        }),
        expect.objectContaining({
          name: "role_rank",
          type: "int32",
          optional: true,
          sort: true,
          index: true,
        }),
      ]),
    );
    expect(
      schema.fields.find((field: { name: string }) => field.name === "role"),
    ).toEqual({
      name: "role",
      type: "string",
      optional: true,
      index: true,
    });
    expect(reindexQueue.add).toHaveBeenCalledTimes(1);
    expect(reindexQueue.add).toHaveBeenCalledWith(
      RefreshAllPlayersJob.name,
      {},
      expect.objectContaining({ jobId: RefreshAllPlayersJob.name }),
    );
  });

  it("adds role_rank to an existing collection and queues a player refresh without recreating it", async () => {
    const create = jest.fn();
    const update = jest.fn().mockResolvedValue(undefined);
    const retrieve = jest.fn().mockResolvedValue({
      fields: [
        {
          name: "role",
          type: "string",
          optional: true,
          index: true,
          sort: false,
        },
      ],
    });
    const collections = jest.fn((name?: string) => {
      if (name === "players") {
        return {
          exists: jest.fn().mockResolvedValue(true),
          retrieve,
          update,
        };
      }
      return { create };
    });
    const service = new TypeSenseService(
      logger as any,
      config as any,
      {} as any,
      matchAssistant as any,
      reindexQueue as any,
    );
    (service as any).client = { collections };

    await service.createPlayerCollection();

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].fields).toEqual(
      expect.arrayContaining([
        {
          name: "role_rank",
          type: "int32",
          optional: true,
          sort: true,
          index: true,
        },
      ]),
    );
    expect(update.mock.calls[0][0].fields).not.toContainEqual({
      name: "role",
      drop: true,
    });
    expect(reindexQueue.add).toHaveBeenCalledWith(
      RefreshAllPlayersJob.name,
      {},
      expect.objectContaining({ jobId: RefreshAllPlayersJob.name }),
    );
  });

  it.each([
    ["competitive only", { competitive: 6100 }, 6100],
    ["wingman only", { wingman: 5200 }, 5200],
    ["duel only", { duel: 4300 }, 4300],
    ["competitive and wingman", { competitive: 6000, wingman: 7000 }, 6000],
    ["all modes", { competitive: 5900, wingman: 6500, duel: 7100 }, 5900],
    ["no ratings", {}, null],
    ["real zero rating", { competitive: 0, wingman: 6500 }, 0],
  ])(
    "indexes the displayed priority for %s",
    async (_label, ratings, expected) => {
      const upsert = jest.fn().mockResolvedValue(undefined);
      const player = {
        elo: {
          ...ratings,
          tournament_wingman: 4800,
        },
        name: "Player",
        role: "user",
        country: null,
        avatar_url: null,
        custom_avatar_url: null,
        roster_image_url: null,
        profile_url: null,
        is_banned: false,
        is_gagged: false,
        is_muted: false,
        teams: [],
        last_sign_in_at: null,
        wins: 0,
        losses: 0,
        total_matches: expected === 0 ? 2 : 0,
        stats: { kills: 0, deaths: 0 },
        sanctions_aggregate: { aggregate: { count: 0 } },
      };
      const hasura = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ players_by_pk: player })
          .mockResolvedValueOnce({ match_lineup_players: [] }),
      };
      const service = new TypeSenseService(
        logger as any,
        config as any,
        hasura as any,
        matchAssistant as any,
        reindexQueue as any,
      );
      (service as any).client = {
        collections: jest.fn(() => ({
          documents: jest.fn(() => ({ upsert })),
        })),
      };

      await service.updatePlayer("76561198000000000");

      const document = upsert.mock.calls[0][0];
      expect(document.elo).toBe(expected);
      expect(document.tournament_elo).toBe(4800);
      expect(document.elo_competitive).toBe(ratings.competitive ?? null);
      expect(document.elo_wingman).toBe(ratings.wingman ?? null);
      expect(document.elo_duel).toBe(ratings.duel ?? null);
      expect(document.total_matches).toBe(expected === 0 ? 2 : 0);
    },
  );

  it.each([
    ["user", 0],
    ["verified_user", 1],
    ["streamer", 2],
    ["moderator", 3],
    ["match_organizer", 4],
    ["tournament_organizer", 5],
    ["administrator", 6],
    ["unknown_role", 0],
    [null, 0],
  ])("indexes role %s with rank %i", async (role, expectedRank) => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const player = {
      elo: {},
      name: "Player",
      role,
      country: null,
      avatar_url: null,
      custom_avatar_url: null,
      roster_image_url: null,
      profile_url: null,
      is_banned: false,
      is_admin_sanctioned: false,
      is_gagged: false,
      is_muted: false,
      teams: [],
      last_sign_in_at: null,
      wins: 0,
      losses: 0,
      total_matches: 0,
      stats: { kills: 0, deaths: 0 },
      sanctions_aggregate: { aggregate: { count: 0 } },
    };
    const hasura = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ players_by_pk: player })
        .mockResolvedValueOnce({ match_lineup_players: [] }),
    };
    const service = new TypeSenseService(
      logger as any,
      config as any,
      hasura as any,
      matchAssistant as any,
      reindexQueue as any,
    );
    (service as any).client = {
      collections: jest.fn(() => ({
        documents: jest.fn(() => ({ upsert })),
      })),
    };

    await service.updatePlayer("76561198000000000");

    expect(upsert.mock.calls[0][0].role_rank).toBe(expectedRank);
  });
});
