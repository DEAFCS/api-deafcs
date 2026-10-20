import { MatchesController } from "../src/matches/matches.controller";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A finished match's server reservation is released at once (tau_matches), but
// its server_id is only cleared later by the API (match_events). A tournament
// reset that runs in between used to keep that stale server_id: going Live
// again then assigned no server, and the row could already be another match's.
// Drives the real ResetTournamentMatch action and the real triggers.
describe("tournament reset drops the match's old server (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let controller: MatchesController;

  const REGION = "TestA";
  const NODE = "reset-node-1";

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentResetServerTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199410000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, REGION);
    await postgres.query(
      `INSERT INTO game_server_nodes (id, region) VALUES ($1, $2)`,
      [NODE, REGION],
    );

    const c = Object.create(MatchesController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    c.postgres = postgres;
    c.matchAssistant = { isOrganizer: jest.fn(async () => true) };
    controller = c;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("UPDATE servers SET reserved_by_match_id = NULL");
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM servers WHERE game_server_node_id IS NOT NULL",
    );
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  let nextPort = 28000;
  const onDemandServer = async (): Promise<string> => {
    const port = nextPort;
    nextPort += 2;
    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, tv_port, enabled, connected, region,
          type, is_dedicated, game_server_node_id)
       VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, $3, true, true, $4,
               'Ranked', false, $5)
       RETURNING id::text AS id`,
      [`on-demand-${port}`, port, port + 1, REGION, NODE],
    );
    return server.id;
  };

  // What assignOnDemandServer writes: its stopOnDemandServer(remove) frees the
  // match's old reservation, then the new reservation, then server_id.
  const assign = async (matchId: string, serverId: string) => {
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id = $1",
      [matchId],
    );
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
      [matchId, serverId],
    );
    await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
      matchId,
      serverId,
    ]);
  };

  const goLive = async (matchId: string) => {
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps
        WHERE NOT EXISTS (SELECT 1 FROM match_maps WHERE match_id = $1)
        ORDER BY name LIMIT 1`,
      [matchId],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      matchId,
    ]);
  };

  const matchRow = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; server_id: string | null }>
    >("SELECT status, server_id::text FROM matches WHERE id = $1", [matchId]);
    return row;
  };

  const reservedBy = async (serverId: string) => {
    const [row] = await postgres.query<
      Array<{ reserved_by_match_id: string | null }>
    >("SELECT reserved_by_match_id::text FROM servers WHERE id = $1", [
      serverId,
    ]);
    return row.reserved_by_match_id;
  };

  const reset = (
    matchId: string,
    options: { winning_lineup_id?: string | null; reset_status?: string } = {},
  ) =>
    controller.ResetTournamentMatch({
      user: { steam_id: "1", role: "administrator" } as any,
      match_id: matchId,
      ...options,
    });

  // A final that ended on its on-demand server, before match_events cleared server_id.
  const finishedFinalOnServer = async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    const [final] = await postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 2`,
      [t.stageIds[0]],
    );
    const serverId = await onDemandServer();
    await assign(final.match_id, serverId);
    await goLive(final.match_id);
    await tfx.winMatch(final.match_id);

    const ended = await matchRow(final.match_id);
    expect(ended.status).toBe("Finished");
    expect(ended.server_id).toBe(serverId);
    expect(await reservedBy(serverId)).toBeNull();

    return { t, matchId: final.match_id, serverId };
  };

  it("a reset match no longer points at the server it finished on", async () => {
    const { matchId, serverId } = await finishedFinalOnServer();

    await reset(matchId);

    expect(await matchRow(matchId)).toEqual({
      status: "WaitingForCheckIn",
      server_id: null,
    });
    expect(await reservedBy(serverId)).toBeNull();
  });

  it("a reset to Scheduled drops the old server too", async () => {
    const { matchId } = await finishedFinalOnServer();

    await controller.ResetTournamentMatch({
      user: { steam_id: "1", role: "administrator" } as any,
      match_id: matchId,
      reset_status: "Scheduled",
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // The tournament's check-in rules may move it on to WaitingForCheckIn.
    const row = await matchRow(matchId);
    expect(["Scheduled", "WaitingForCheckIn"]).toContain(row.status);
    expect(row.server_id).toBeNull();
  });

  it("never takes the server away from another match that has it now", async () => {
    const { matchId, serverId } = await finishedFinalOnServer();
    const { matchId: otherMatchId } = await fx.bareMatch();
    await assign(otherMatchId, serverId);

    await reset(matchId);

    expect((await matchRow(matchId)).server_id).toBeNull();
    expect(await reservedBy(serverId)).toBe(otherMatchId);
    expect((await matchRow(otherMatchId)).server_id).toBe(serverId);
  });

  it("leaves server_id alone when the reset only changes the winner", async () => {
    const { matchId, serverId } = await finishedFinalOnServer();
    const [lineups] = await postgres.query<Array<{ lineup_2_id: string }>>(
      "SELECT lineup_2_id::text FROM matches WHERE id = $1",
      [matchId],
    );

    await reset(matchId, { winning_lineup_id: lineups.lineup_2_id });

    expect(await matchRow(matchId)).toEqual({
      status: "Finished",
      server_id: serverId,
    });
  });

  it("survives repeated reset and replay, each time on a fresh server", async () => {
    const { matchId, serverId: first } = await finishedFinalOnServer();
    const { matchId: otherMatchId } = await fx.bareMatch();
    await assign(otherMatchId, first);

    await reset(matchId);

    // Live again on a new server, finished, reset again.
    const second = await onDemandServer();
    await assign(matchId, second);
    await goLive(matchId);
    expect(await matchRow(matchId)).toEqual({
      status: "Live",
      server_id: second,
    });
    expect(await reservedBy(second)).toBe(matchId);

    await tfx.winMatch(matchId);
    expect(await reservedBy(second)).toBeNull();

    await reset(matchId);
    await reset(matchId);

    expect(await matchRow(matchId)).toEqual({
      status: "WaitingForCheckIn",
      server_id: null,
    });
    expect(await reservedBy(second)).toBeNull();
    expect(await reservedBy(first)).toBe(otherMatchId);
  });

  it("refuses to reset a Live match and keeps its server", async () => {
    const t = await tfx.launch(SE4, 4);
    const [semi] = await postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 1 ORDER BY match_number LIMIT 1`,
      [t.stageIds[0]],
    );
    const serverId = await onDemandServer();
    await assign(semi.match_id, serverId);
    await goLive(semi.match_id);

    await expect(reset(semi.match_id)).rejects.toThrow(
      /cannot reset a live match/,
    );

    expect(await matchRow(semi.match_id)).toEqual({
      status: "Live",
      server_id: serverId,
    });
    expect(await reservedBy(serverId)).toBe(semi.match_id);
  });

  describe("tbu_matches releases only the match's own reservation", () => {
    it("a Live match moved to another server frees the old one", async () => {
      const { matchId } = await fx.bareMatch();
      const before = await onDemandServer();
      const after = await onDemandServer();
      await assign(matchId, before);

      // A reboot that moves server_id before the old reservation is freed.
      await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
        matchId,
        after,
      ]);

      expect(await reservedBy(before)).toBeNull();
    });

    it("clearing a stale server_id keeps another match's reservation", async () => {
      const { matchId } = await fx.bareMatch();
      const { matchId: otherMatchId } = await fx.bareMatch();
      const serverId = await onDemandServer();
      await assign(matchId, serverId);
      // The server was handed on while this match still pointed at it.
      await assign(otherMatchId, serverId);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [matchId],
      );

      expect(await reservedBy(serverId)).toBe(otherMatchId);
    });

    it("a later update of a finished match keeps another match's reservation", async () => {
      const { matchId, serverId } = await finishedFinalOnServer();
      const { matchId: otherMatchId } = await fx.bareMatch();
      await assign(otherMatchId, serverId);

      // tau_matches runs again on any update while the match is Finished.
      await postgres.query(
        "UPDATE matches SET server_id = server_id WHERE id = $1",
        [matchId],
      );

      expect(await reservedBy(serverId)).toBe(otherMatchId);
    });

    it("a dedicated server reserved by the match is still freed", async () => {
      const { matchId } = await fx.bareMatch();
      const [dedicated] = await postgres.query<Array<{ id: string }>>(
        "SELECT id::text FROM servers WHERE is_dedicated AND region = $1 LIMIT 1",
        [REGION],
      );
      await assign(matchId, dedicated.id);

      await postgres.query(
        "UPDATE matches SET server_id = NULL WHERE id = $1",
        [matchId],
      );

      expect(await reservedBy(dedicated.id)).toBeNull();
    });
  });
});
