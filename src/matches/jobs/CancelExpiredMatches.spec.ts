import { CancelExpiredMatches } from "./CancelExpiredMatches";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

// Defaults to a genuine no-show on both lineups (steam_id set, connected_at
// null) so the existing forfeit/organizer-attention scenarios below keep
// exercising exactly the path they did before force-start-on-no-no-show was
// added -- tests that want the "everyone connected" case override
// lineup_players explicitly (see "force-starts..." below).
const expiredTournamentMatch = (overrides: Record<string, any> = {}) => ({
  id: "match-1",
  is_tournament_match: true,
  server_id: "server-1",
  options: {
    match_mode: "auto",
  },
  lineup_1: {
    id: "lineup-1",
    is_ready: false,
    lineup_players: [{ steam_id: "111", connected_at: null }],
  },
  lineup_2: {
    id: "lineup-2",
    is_ready: false,
    lineup_players: [{ steam_id: "222", connected_at: null }],
  },
  ...overrides,
});

describe("CancelExpiredMatches", () => {
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const hasura = {
    mutation: jest.fn(),
    query: jest.fn(),
  };
  const notifications = {
    send: jest.fn(),
  };
  const configService = {
    get: jest.fn(),
  };
  const disconnectBudget = {
    applyLeaverBan: jest.fn(),
  };
  const rcon = {
    send: jest.fn(),
  };
  const rconService = {
    connect: jest.fn(),
    disconnect: jest.fn(),
  };

  let job: CancelExpiredMatches;
  let tournamentMatches: any[];
  let pendingNotificationCount: number;

  beforeEach(() => {
    jest.clearAllMocks();
    tournamentMatches = [];
    pendingNotificationCount = 0;
    hasura.mutation.mockResolvedValue({
      update_matches: {
        affected_rows: 0,
      },
    });
    hasura.query.mockImplementation(async (query: any) => {
      if (query.notifications_aggregate) {
        return {
          notifications_aggregate: {
            aggregate: { count: pendingNotificationCount },
          },
        };
      }

      // getExpiredNonTournamentMatches() and getTournamentMatches() both
      // query `matches` -- distinguish by which is_tournament_match filter
      // is present so this spec (which only exercises tournament behavior)
      // never accidentally also feeds its fixtures through the
      // non-tournament path.
      const whereClauses = query.matches?.__args?.where?._and ?? [];
      const isTournamentQuery = whereClauses.some(
        (clause: any) => clause.is_tournament_match?._eq === true,
      );

      return { matches: isTournamentQuery ? tournamentMatches : [] };
    });
    configService.get.mockReturnValue({ webDomain: "https://example.com" });
    rconService.connect.mockResolvedValue(rcon);
    job = new CancelExpiredMatches(
      logger as any,
      hasura as any,
      notifications as any,
      configService as any,
      disconnectBudget as any,
      rconService as any,
    );
  });

  it("requests organizer attention for admin-mode tournament matches when neither lineup is ready", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
      }),
    ];

    await expect(job.process()).resolves.toBe(1);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "match-1",
            },
            _set: {
              cancels_at: null,
            },
          }),
        }),
      }),
    );
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "Forfeit",
            }),
          }),
        }),
      }),
    );
    expect(notifications.send).toHaveBeenCalledWith(
      "MatchSupport",
      expect.objectContaining({
        message: expect.stringContaining(
          'href="https://example.com/matches/match-1"',
        ),
        title: "Tournament match requires attention",
        role: "tournament_organizer",
        entity_id: "match-1",
      }),
      undefined,
      DISCORD_COLORS.RED,
    );
    expect(rconService.connect).not.toHaveBeenCalled();
  });

  it("does not re-notify when an organizer notification is already pending", async () => {
    pendingNotificationCount = 1;
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
      }),
    ];

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              cancels_at: null,
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("forfeits auto-mode tournament matches when neither lineup is ready", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.25);
    tournamentMatches = [expiredTournamentMatch()];

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "match-1",
            },
            _set: {
              status: "Forfeit",
              winning_lineup_id: "lineup-1",
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
    expect(rconService.connect).not.toHaveBeenCalled();
  });

  it("forfeits to the ready lineup even in admin mode", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
        lineup_2: {
          id: "lineup-2",
          is_ready: true,
          lineup_players: [{ steam_id: "222", connected_at: null }],
        },
      }),
    ];

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              status: "Forfeit",
              winning_lineup_id: "lineup-2",
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("force-starts a tournament match when everyone has connected but nobody readied up", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        lineup_1: {
          id: "lineup-1",
          is_ready: false,
          lineup_players: [{ steam_id: "111", connected_at: "2026-08-07" }],
        },
        lineup_2: {
          id: "lineup-2",
          is_ready: false,
          lineup_players: [{ steam_id: "222", connected_at: "2026-08-07" }],
        },
      }),
    ];

    await job.process();

    expect(rconService.connect).toHaveBeenCalledWith("server-1");
    expect(rcon.send).toHaveBeenCalledWith("force_ready");
    expect(rconService.disconnect).toHaveBeenCalledWith("server-1");
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.anything(),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });
});
