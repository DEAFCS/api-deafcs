import { TournamentsController } from "./tournaments.controller";

// Unit-level coverage for the deleteTournament action: authorization/status/
// league guards, the exact SQL transaction order (awards -> detach brackets
// -> match_map_demos -> matches -> tournament row, all atomic), and the
// strict separation between the DB transaction (which must own every
// database-owned deletion, including matches) and the best-effort S3 purge
// that only runs after a successful commit and never touches the database.
// DB-level behavior (actual FK/trigger interactions, the
// award_occurrences_calculated_tournament constraint, real rollback) is
// covered separately by the SQL-driven suite in
// test/tournament-deletion.spec.ts.
describe("TournamentsController.deleteTournament", () => {
  const tournamentId = "11111111-1111-1111-1111-111111111111";
  const user = { steam_id: "76561199000000001" } as any;

  const okTournament = {
    id: tournamentId,
    status: "Setup",
    is_organizer: true,
  };

  const noLeagueLinks = {
    league_season_divisions_aggregate: { aggregate: { count: 0 } },
    league_relegation_playoffs_aggregate: { aggregate: { count: 0 } },
  };

  let controller: TournamentsController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { transaction: jest.Mock };
  let awards: { deleteTournamentAwardRecords: jest.Mock };
  let clips: { deleteClipsForMatch: jest.Mock };
  let demoMetadata: { deleteDemosForMatch: jest.Mock };
  let logger: { log: jest.Mock; error: jest.Mock };
  let client: { query: jest.Mock };

  // Drives the fake transaction client purely off the SQL text, mirroring
  // what Postgres would actually return for each statement in
  // deleteTournamentMatchRows. `detachedIds` is what the detach CTE reports
  // as previously-linked match ids; `deletableIds` (defaults to the same
  // list) is what the NOT-EXISTS-guarded SELECT reports as safe to delete.
  const configureMatchRows = (
    detachedIds: string[],
    deletableIds: string[] = detachedIds,
  ) => {
    client.query.mockImplementation(async (sql: string) => {
      if (/WITH owned_brackets/i.test(sql)) {
        return { rows: detachedIds.map((match_id) => ({ match_id })) };
      }
      if (/SELECT m\.id FROM public\.matches/i.test(sql)) {
        return { rows: deletableIds.map((id) => ({ id })) };
      }
      if (/DELETE FROM public\.tournaments/i.test(sql)) {
        return { rows: [{ id: tournamentId }] };
      }
      return { rows: [] };
    });
  };

  beforeEach(() => {
    logger = { log: jest.fn(), error: jest.fn() };
    hasura = { query: jest.fn(), mutation: jest.fn() };
    postgres = { transaction: jest.fn() };
    awards = { deleteTournamentAwardRecords: jest.fn() };
    clips = { deleteClipsForMatch: jest.fn().mockResolvedValue(undefined) };
    demoMetadata = {
      deleteDemosForMatch: jest.fn().mockResolvedValue(undefined),
    };
    client = { query: jest.fn() };

    // Default: the transaction mock actually invokes the callback with a fake
    // client, mirroring PostgresService.transaction's real shape.
    postgres.transaction.mockImplementation(async (fn: any) => fn(client));
    configureMatchRows([]);

    controller = new TournamentsController(
      logger as any,
      hasura as any,
      demoMetadata as any,
      clips as any,
      {} as any, // tournamentVoice
      postgres as any,
      awards as any,
      {} as any, // notifications
      {} as any, // teamGeneration
      { assertAccepted: jest.fn() } as any, // terms
    );
  });

  const queueAuthQueries = () => {
    hasura.query
      .mockResolvedValueOnce({ tournaments_by_pk: okTournament }) // auth check
      .mockResolvedValueOnce(noLeagueLinks); // league check
  };

  const matchQueryCallIndex = (pattern: RegExp) =>
    client.query.mock.calls.findIndex((call) => pattern.test(call[0]));

  const callOrderFor = (mockFn: jest.Mock, callIndex: number) =>
    mockFn.mock.invocationCallOrder[callIndex];

  it("rejects when the tournament does not exist", async () => {
    hasura.query.mockResolvedValueOnce({ tournaments_by_pk: null });

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/tournament not found/i);

    expect(postgres.transaction).not.toHaveBeenCalled();
  });

  it("rejects a non-organizer", async () => {
    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: { ...okTournament, is_organizer: false },
    });

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/not the tournament organizer/i);

    expect(postgres.transaction).not.toHaveBeenCalled();
  });

  it("rejects deleting a Live tournament", async () => {
    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: { ...okTournament, status: "Live" },
    });

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/cannot delete a live tournament/i);

    expect(postgres.transaction).not.toHaveBeenCalled();
  });

  it("rejects a tournament that belongs to a league", async () => {
    hasura.query
      .mockResolvedValueOnce({ tournaments_by_pk: okTournament })
      .mockResolvedValueOnce({
        league_season_divisions_aggregate: { aggregate: { count: 1 } },
        league_relegation_playoffs_aggregate: { aggregate: { count: 0 } },
      });

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/belongs to a league/i);

    expect(postgres.transaction).not.toHaveBeenCalled();
  });

  it("detaches bracket rows, deletes match_map_demos, deletes matches, then the tournament -- in that order, inside one transaction", async () => {
    queueAuthQueries();
    configureMatchRows(["match-1"]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    expect(postgres.transaction).toHaveBeenCalledTimes(1);
    expect(awards.deleteTournamentAwardRecords).toHaveBeenCalledWith(
      client,
      tournamentId,
    );

    const awardsOrder = callOrderFor(awards.deleteTournamentAwardRecords, 0);
    const detachOrder = callOrderFor(
      client.query,
      matchQueryCallIndex(/WITH owned_brackets/i),
    );
    const deletableOrder = callOrderFor(
      client.query,
      matchQueryCallIndex(/SELECT m\.id FROM public\.matches/i),
    );
    const demosOrder = callOrderFor(
      client.query,
      matchQueryCallIndex(/DELETE FROM public\.match_map_demos/i),
    );
    const matchesOrder = callOrderFor(
      client.query,
      matchQueryCallIndex(/^\s*DELETE FROM public\.matches/i),
    );
    const tournamentOrder = callOrderFor(
      client.query,
      matchQueryCallIndex(/DELETE FROM public\.tournaments/i),
    );

    expect(awardsOrder).toBeLessThan(detachOrder);
    expect(detachOrder).toBeLessThan(deletableOrder);
    expect(deletableOrder).toBeLessThan(demosOrder);
    expect(demosOrder).toBeLessThan(matchesOrder);
    expect(matchesOrder).toBeLessThan(tournamentOrder);

    // The detach step locks and scopes to this tournament's own brackets only.
    const detachCall = client.query.mock.calls[matchQueryCallIndex(/WITH owned_brackets/i)];
    expect(detachCall[0]).toMatch(/FOR UPDATE/i);
    expect(detachCall[0]).toMatch(/SET match_id = NULL/i);
    expect(detachCall[0]).toMatch(/ts\.tournament_id = \$1/i);
    expect(detachCall[0]).toMatch(/SELECT DISTINCT match_id/i);
    expect(detachCall[1]).toEqual([tournamentId]);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM public\.match_map_demos/i),
      [["match-1"]],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*DELETE FROM public\.matches/i),
      [["match-1"]],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM public\.tournaments WHERE id = \$1/i),
      [tournamentId],
    );
  });

  it("re-verifies with NOT EXISTS before deleting each candidate match", async () => {
    queueAuthQueries();
    configureMatchRows(["match-1"]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    const deletableCall = client.query.mock.calls.find((call) =>
      /SELECT m\.id FROM public\.matches/i.test(call[0]),
    );
    expect(deletableCall[0]).toMatch(/NOT EXISTS/i);
    expect(deletableCall[0]).toMatch(/tournament_brackets/i);
  });

  it("skips the match-row deletes entirely when the tournament has no matches to detach", async () => {
    queueAuthQueries();
    configureMatchRows([]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    expect(matchQueryCallIndex(/SELECT m\.id FROM public\.matches/i)).toBe(-1);
    expect(matchQueryCallIndex(/DELETE FROM public\.match_map_demos/i)).toBe(
      -1,
    );
    expect(matchQueryCallIndex(/^\s*DELETE FROM public\.matches/i)).toBe(-1);
    expect(clips.deleteClipsForMatch).not.toHaveBeenCalled();
  });

  it("does not delete a candidate match that is still referenced by another bracket, or purge its assets", async () => {
    queueAuthQueries();
    // Two brackets detached (match-1, match-2), but match-2 is still
    // referenced elsewhere (e.g. another tournament's bracket), so the
    // NOT-EXISTS-guarded SELECT only reports match-1 as deletable.
    configureMatchRows(["match-1", "match-2"], ["match-1"]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM public\.match_map_demos/i),
      [["match-1"]],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*DELETE FROM public\.matches/i),
      [["match-1"]],
    );
    expect(clips.deleteClipsForMatch).toHaveBeenCalledTimes(1);
    expect(clips.deleteClipsForMatch).toHaveBeenCalledWith("match-1");
    expect(clips.deleteClipsForMatch).not.toHaveBeenCalledWith("match-2");
  });

  it("never calls Hasura's delete_tournaments_by_pk or delete_matches_by_pk mutations from inside the transaction path", async () => {
    queueAuthQueries();
    configureMatchRows(["match-1"]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("throws if the DELETE did not remove exactly one tournament row", async () => {
    queueAuthQueries();
    client.query.mockResolvedValue({ rows: [] });

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/expected to delete exactly one tournament row/i);
  });

  it("does not purge S3 when the DB transaction fails", async () => {
    queueAuthQueries();
    postgres.transaction.mockRejectedValue(new Error("forced sql failure"));

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).rejects.toThrow(/forced sql failure/);

    expect(clips.deleteClipsForMatch).not.toHaveBeenCalled();
    expect(demoMetadata.deleteDemosForMatch).not.toHaveBeenCalled();
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("runs S3 purge only after a successful commit, and never calls delete_matches_by_pk", async () => {
    queueAuthQueries();
    configureMatchRows(["match-1"]);

    await controller.deleteTournament({ user, tournament_id: tournamentId });

    const transactionOrder = postgres.transaction.mock.invocationCallOrder[0];
    const clipsOrder = clips.deleteClipsForMatch.mock.invocationCallOrder[0];
    expect(clipsOrder).toBeGreaterThan(transactionOrder);

    expect(clips.deleteClipsForMatch).toHaveBeenCalledWith("match-1");
    expect(demoMetadata.deleteDemosForMatch).toHaveBeenCalledWith("match-1");
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("a failed S3 purge does not throw or report the database deletion as failed", async () => {
    queueAuthQueries();
    configureMatchRows(["match-1"]);
    clips.deleteClipsForMatch.mockRejectedValue(new Error("s3 down"));

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).resolves.toEqual({ success: true });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to purge S3 assets for match match-1"),
      expect.any(Error),
    );
    // The transaction already committed; cleanup failure must not roll it back
    // or re-trigger tournament/match deletion.
    expect(postgres.transaction).toHaveBeenCalledTimes(1);
  });

  it("returns success once the transaction commits, even if there were no matches or awards", async () => {
    queueAuthQueries();

    await expect(
      controller.deleteTournament({ user, tournament_id: tournamentId }),
    ).resolves.toEqual({ success: true });
  });
});

describe("TournamentsController tournament_events (Cancelled)", () => {
  const tournamentId = "22222222-2222-2222-2222-222222222222";

  let controller: TournamentsController;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { transaction: jest.Mock };
  let clips: { deleteClipsForMatch: jest.Mock };
  let demoMetadata: { deleteDemosForMatch: jest.Mock };
  let tournamentVoice: { removeTournamentVoice: jest.Mock };
  let logger: { log: jest.Mock; error: jest.Mock };
  let client: { query: jest.Mock };

  const configureMatchRows = (
    detachedIds: string[],
    deletableIds: string[] = detachedIds,
  ) => {
    client.query.mockImplementation(async (sql: string) => {
      if (/WITH owned_brackets/i.test(sql)) {
        return { rows: detachedIds.map((match_id) => ({ match_id })) };
      }
      if (/SELECT m\.id FROM public\.matches/i.test(sql)) {
        return { rows: deletableIds.map((id) => ({ id })) };
      }
      return { rows: [] };
    });
  };

  beforeEach(() => {
    logger = { log: jest.fn(), error: jest.fn() };
    hasura = { query: jest.fn(), mutation: jest.fn() };
    postgres = { transaction: jest.fn() };
    clips = { deleteClipsForMatch: jest.fn().mockResolvedValue(undefined) };
    demoMetadata = {
      deleteDemosForMatch: jest.fn().mockResolvedValue(undefined),
    };
    tournamentVoice = { removeTournamentVoice: jest.fn() };
    client = { query: jest.fn() };
    postgres.transaction.mockImplementation(async (fn: any) => fn(client));
    configureMatchRows([]);

    controller = new TournamentsController(
      logger as any,
      hasura as any,
      demoMetadata as any,
      clips as any,
      tournamentVoice as any,
      postgres as any,
      {} as any, // awards
      {} as any, // notifications
      {} as any, // teamGeneration
      { assertAccepted: jest.fn() } as any, // terms
    );
  });

  it("detaches and deletes cancelled-tournament match rows atomically, then purges S3, without calling delete_matches_by_pk", async () => {
    configureMatchRows(["match-1"]);

    await controller.tournament_events({
      op: "UPDATE",
      old: { id: tournamentId, status: "RegistrationClosed" },
      new: { id: tournamentId, status: "Cancelled" },
    } as any);

    expect(postgres.transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*DELETE FROM public\.matches/i),
      [["match-1"]],
    );
    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(hasura.query).not.toHaveBeenCalled();

    const transactionOrder = postgres.transaction.mock.invocationCallOrder[0];
    const clipsOrder = clips.deleteClipsForMatch.mock.invocationCallOrder[0];
    expect(clipsOrder).toBeGreaterThan(transactionOrder);
  });

  it("does not purge S3 when there was nothing to detach", async () => {
    configureMatchRows([]);

    await controller.tournament_events({
      op: "UPDATE",
      old: { id: tournamentId, status: "RegistrationClosed" },
      new: { id: tournamentId, status: "Cancelled" },
    } as any);

    expect(clips.deleteClipsForMatch).not.toHaveBeenCalled();
    expect(demoMetadata.deleteDemosForMatch).not.toHaveBeenCalled();
  });
});
