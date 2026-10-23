import { PostgresService } from "./../src/postgres/postgres.service";
import { MatchRecoveryService } from "../src/matches/match-recovery/match-recovery.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

const steamId = (accountId: number) =>
  (BigInt(accountId) + 76561197960265728n).toString();

const backup = (accountId: number, name: string, cash: number) => `"SaveFile"
{
	"round"		"1"
	"PlayersOnTeam1"
	{
		"${accountId}"
		{
			"name"		"${name}"
			"cash"		"${cash}"
			"kills"		"1"
			"deaths"		"0"
			"assists"		"0"
			"Items"
			{
				"item"		"weapon_m4a1_silencer"
			}
		}
	}
}
`;

// Runs MatchRecoveryService's own queries against a migrated database, and
// drives a restart through the real match triggers.
describe("match recovery (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchRecoveryTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199410000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    // DEAFCS: players have terms acceptances.
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const service = (sent: Array<number> = []) =>
    new MatchRecoveryService(
      { log: jest.fn(), warn: jest.fn() } as never,
      postgres,
      {
        requestRoundRestore: async (_matchId: string, round: number) => {
          sent.push(round);
          return "";
        },
        refreshServerMatch: async (serverId: string): Promise<void> => {
          refreshed.push(serverId);
        },
        restartServerMap: async (): Promise<string> => "",
      } as never,
      {
        stopLiveIfRunning: async (matchId: string): Promise<void> => {
          streamsStopped.push(matchId);
        },
      } as never,
    );

  let refreshed: Array<string> = [];
  let streamsStopped: Array<string> = [];
  beforeEach(() => {
    refreshed = [];
    streamsStopped = [];
  });

  const admin = {
    steam_id: "76561199419999999",
    role: "administrator",
  } as const;

  // A duel on its second map: map 1 is over, map 2 is being played.
  const liveMatch = async () => {
    const match = await fx.match({ type: "Duel", bestOf: 3 });
    const [finished] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 1, 'Finished', 'CT', 'TERRORIST' FROM maps ORDER BY name LIMIT 1
       RETURNING id`,
      [match.id],
    );
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 2, 'Live', 'CT', 'TERRORIST' FROM maps ORDER BY name OFFSET 1 LIMIT 1
       RETURNING id`,
      [match.id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);

    for (const [lineupId, accountId, name] of [
      [match.lineup_1_id, 157864, "vexa"],
      [match.lineup_2_id, 235177, "osk"],
    ] as Array<[string, number, string]>) {
      await postgres.query(
        "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
        [steamId(accountId), name],
      );
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id, is_connected)
         VALUES ($1, $2, true)`,
        [lineupId, steamId(accountId)],
      );
    }

    for (const [mapId, round, file] of [
      [finished.id, 1, null],
      [map.id, 1, backup(157864, "vexa", 3250)],
      [map.id, 2, null],
    ] as Array<[string, number, string | null]>) {
      await postgres.query(
        `INSERT INTO match_map_rounds
           (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
            "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
            lineup_1_side, lineup_2_side, winning_side, backup_file)
         VALUES ($1, $2, $2, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT', $3)`,
        [mapId, round, file],
      );
    }

    await fx.kill(
      { matchId: match.id, mapId: map.id },
      steamId(157864),
      steamId(235177),
      { round: 2 },
    );

    return { match, mapId: map.id, finishedMapId: finished.id };
  };

  it("reads the current map's backups and who is connected", async () => {
    const { match, mapId } = await liveMatch();
    await postgres.query(
      "UPDATE match_lineup_players SET is_connected = false WHERE steam_id = $1",
      [steamId(235177)],
    );

    const result = await service().getRestoreRounds(match.id, admin);

    expect(result).toMatchObject({
      match_map_id: mapId,
      restorable: true,
      blocked_reason: null,
      live_round: 3,
      economy_hidden: false,
      connected_players: 1,
      expected_players: 2,
      disconnected: ["osk"],
    });
    expect(result.rounds.map((round) => round.has_backup)).toEqual([
      true,
      false,
    ]);
    expect(result.rounds[0].players).toEqual([
      expect.objectContaining({
        steam_id: steamId(157864),
        lineup: 1,
        cash: 3250,
        weapons: ["weapon_m4a1_silencer"],
      }),
    ]);
  });

  it("treats a lineup's coach as on that team", async () => {
    const { match } = await liveMatch();
    const coach = await fx.player();
    await postgres.query(
      "UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1",
      [match.lineup_1_id, coach],
    );

    const result = await service().getRestoreRounds(match.id, {
      steam_id: coach,
      role: "user",
    });

    expect(result).toMatchObject({
      economy_hidden: true,
      blocked_reason: "team_member",
    });
    expect(result.rounds[0].players).toEqual([]);
    await expect(
      service().restoreRound(match.id, 1, { steam_id: coach, role: "user" }),
    ).rejects.toThrow("organizers on one of the teams can't restore rounds");
  });

  it("sends a restore only for a round that has a backup", async () => {
    const { match } = await liveMatch();
    const sent: Array<number> = [];

    await expect(
      service(sent).restoreRound(match.id, 2, admin),
    ).rejects.toThrow("round 2 has no backup to restore");
    await service(sent).restoreRound(match.id, 1, admin);

    expect(sent).toEqual([1]);
  });

  it("restarts a live match from check-in with the map in progress back at the start", async () => {
    const { match, mapId, finishedMapId } = await liveMatch();

    await service().restartMatch(match.id, admin);

    const [after] = await postgres.query<
      Array<{ status: string; winning_lineup_id: string | null }>
    >("SELECT status, winning_lineup_id FROM matches WHERE id = $1", [
      match.id,
    ]);
    expect(after).toEqual({
      status: "WaitingForCheckIn",
      winning_lineup_id: null,
    });

    const maps = await postgres.query<Array<{ id: string; status: string }>>(
      'SELECT id, status FROM match_maps WHERE match_id = $1 ORDER BY "order"',
      [match.id],
    );
    expect(maps).toEqual([
      { id: finishedMapId, status: "Finished" },
      { id: mapId, status: "Scheduled" },
    ]);

    const live = await postgres.query<Array<{ table: string; left: number }>>(
      `SELECT 'rounds' AS table, count(*)::int AS left FROM match_map_rounds
        WHERE match_map_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'kills', count(*)::int FROM player_kills
        WHERE match_map_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'finished rounds', count(*)::int FROM match_map_rounds
        WHERE match_map_id = $2 AND deleted_at IS NULL`,
      [mapId, finishedMapId],
    );
    expect(live).toEqual([
      { table: "rounds", left: 0 },
      { table: "kills", left: 0 },
      { table: "finished rounds", left: 1 },
    ]);
  });

  // Canceling stamps cancels_at with now, and without auto-cancel nothing
  // re-arms it, so CancelExpiredMatches would cancel the reopened match again.
  it("doesn't reopen the match already past its deadline", async () => {
    const { match } = await liveMatch();
    await postgres.query(
      "UPDATE match_options SET auto_cancellation = false WHERE id = $1",
      [match.options_id],
    );

    await service().restartMatch(match.id, admin);

    const [after] = await postgres.query<
      Array<{
        status: string;
        cancels_at: Date | null;
        server_id: string | null;
      }>
    >("SELECT status, cancels_at, server_id FROM matches WHERE id = $1", [
      match.id,
    ]);
    expect(after).toEqual({
      status: "WaitingForCheckIn",
      cancels_at: null,
      server_id: null,
    });
  });

  it("puts a map still in its knife round back to the start", async () => {
    const { match, mapId } = await liveMatch();
    await postgres.query(
      "UPDATE match_maps SET status = 'Knife' WHERE id = $1",
      [mapId],
    );

    await service().restartMatch(match.id, admin);

    const [map] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM match_maps WHERE id = $1",
      [mapId],
    );
    expect(map.status).toBe("Scheduled");
  });

  // DEAFCS: Restart Match goes straight back to check-in. Upstream's
  // Canceled -> WaitingForCheckIn leaves Canceled, and with a map veto
  // tbu_matches then deletes every map: the played maps' stats go with them
  // (ON DELETE CASCADE), and a map with a demo stops it (ON DELETE RESTRICT).
  describe("Restart Match keeps what was played", () => {
    beforeAll(async () => {
      await postgres.query(
        `CREATE TABLE IF NOT EXISTS test_match_status_log (
           match_id uuid, old_status text, new_status text, at serial)`,
      );
      await postgres.query(
        `CREATE OR REPLACE FUNCTION test_log_match_status() RETURNS trigger
           LANGUAGE plpgsql AS $$
         BEGIN
           INSERT INTO test_match_status_log (match_id, old_status, new_status)
           VALUES (NEW.id, OLD.status, NEW.status);
           RETURN NEW;
         END $$`,
      );
      await postgres.query(
        `CREATE OR REPLACE TRIGGER zz_test_log_match_status
           AFTER UPDATE OF status ON matches FOR EACH ROW
           WHEN (OLD.status IS DISTINCT FROM NEW.status)
           EXECUTE FUNCTION test_log_match_status()`,
      );
    });

    afterAll(async () => {
      await postgres.query(
        "DROP TRIGGER IF EXISTS zz_test_log_match_status ON matches",
      );
    });

    // A veto match on map `liveOrder`: the maps before it are finished, each
    // with a round, a kill and a demo; the live map has a round and a kill.
    const vetoMatch = async (bestOf: number, liveOrder: number) => {
      const match = await fx.match({ type: "Duel", bestOf, mapVeto: true });
      const maps = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM maps WHERE id IN (SELECT map_id FROM _map_pool WHERE map_pool_id = (SELECT map_pool_id FROM match_options WHERE id = $1)) ORDER BY name",
        [match.options_id],
      );
      expect(maps.length).toBeGreaterThan(bestOf);

      // The veto that was played: its trigger only takes picks during a veto.
      await postgres.transaction(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
           VALUES ($1, 'Ban', $2, $3)`,
          [match.id, match.lineup_1_id, maps[bestOf].id],
        );
      });

      const mapIds: Array<string> = [];
      for (let order = 1; order <= bestOf; order++) {
        const [map] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
           VALUES ($1, $2, $3, $4, 'CT', 'TERRORIST') RETURNING id`,
          [
            match.id,
            maps[order - 1].id,
            order,
            order < liveOrder
              ? "Finished"
              : order === liveOrder
                ? "Live"
                : "Scheduled",
          ],
        );
        mapIds.push(map.id);
      }
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        match.id,
      ]);

      const [vexa, osk] = [steamId(157864), steamId(235177)];
      await postgres.query(
        "INSERT INTO players (steam_id, name) VALUES ($1, 'vexa'), ($2, 'osk')",
        [vexa, osk],
      );
      for (const mapId of mapIds.slice(0, liveOrder)) {
        await postgres.query(
          `INSERT INTO match_map_rounds
             (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
              "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
              lineup_1_side, lineup_2_side, winning_side)
           VALUES ($1, 1, 1, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT')`,
          [mapId],
        );
        await fx.kill({ matchId: match.id, mapId }, vexa, osk, { round: 1 });
      }
      for (const mapId of mapIds.slice(0, liveOrder - 1)) {
        await postgres.query(
          `INSERT INTO match_map_demos (match_id, match_map_id, file, size)
           VALUES ($1, $2, 'map.dem', 1)`,
          [match.id, mapId],
        );
      }

      return { match, mapIds };
    };

    const kept = async (matchId: string) => {
      const [row] = await postgres.query<
        Array<{
          maps: Array<string>;
          picks: number;
          demos: number;
          rounds: number;
          kills: number;
          undone_rounds: number;
          undone_kills: number;
        }>
      >(
        `SELECT
           (SELECT array_agg(status ORDER BY "order") FROM match_maps WHERE match_id = $1) AS maps,
           (SELECT count(*)::int FROM match_map_veto_picks WHERE match_id = $1) AS picks,
           (SELECT count(*)::int FROM match_map_demos WHERE match_id = $1) AS demos,
           (SELECT count(*)::int FROM match_map_rounds r JOIN match_maps mm ON mm.id = r.match_map_id
             WHERE mm.match_id = $1 AND r.deleted_at IS NULL) AS rounds,
           (SELECT count(*)::int FROM player_kills WHERE match_id = $1 AND deleted_at IS NULL) AS kills,
           (SELECT count(*)::int FROM match_map_rounds r JOIN match_maps mm ON mm.id = r.match_map_id
             WHERE mm.match_id = $1 AND r.deleted_at IS NOT NULL) AS undone_rounds,
           (SELECT count(*)::int FROM player_kills WHERE match_id = $1 AND deleted_at IS NOT NULL) AS undone_kills`,
        [matchId],
      );
      return row;
    };

    it("keeps a best of 1's vetoed map and its undone rounds", async () => {
      const { match, mapIds } = await vetoMatch(1, 1);

      await service().restartMatch(match.id, admin);

      expect(await kept(match.id)).toEqual({
        maps: ["Scheduled"],
        picks: 1,
        demos: 0,
        rounds: 0,
        kills: 0,
        undone_rounds: 1,
        undone_kills: 1,
      });
      const [map] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(map.id).toBe(mapIds[0]);
    });

    it("keeps a best of 3's finished map with its stats and demo", async () => {
      const { match } = await vetoMatch(3, 2);

      await service().restartMatch(match.id, admin);

      expect(await kept(match.id)).toEqual({
        maps: ["Finished", "Scheduled", "Scheduled"],
        picks: 1,
        demos: 1,
        rounds: 1,
        kills: 1,
        undone_rounds: 1,
        undone_kills: 1,
      });
    });

    it("changes the status once, straight back to check-in", async () => {
      const { match } = await vetoMatch(3, 2);
      await postgres.query("DELETE FROM test_match_status_log");

      await service().restartMatch(match.id, admin);

      expect(
        await postgres.query(
          "SELECT old_status, new_status FROM test_match_status_log WHERE match_id = $1 ORDER BY at",
          [match.id],
        ),
      ).toEqual([{ old_status: "Live", new_status: "WaitingForCheckIn" }]);
    });

    it("goes Live again on the same maps once both teams check in", async () => {
      const { match, mapIds } = await vetoMatch(3, 2);
      await service().restartMatch(match.id, admin);

      // What checkIntoMatch writes once both lineups are ready.
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        match.id,
      ]);

      const [after] = await postgres.query<
        Array<{ status: string; current: string }>
      >(
        "SELECT status, get_current_match_map(m)::text AS current FROM matches m WHERE id = $1",
        [match.id],
      );
      expect(after).toEqual({ status: "Live", current: mapIds[1] });
    });

    const onServer = async (matchId: string, dedicated: boolean) => {
      await postgres.query(
        `INSERT INTO game_server_nodes (id, region, enabled, enabled_for_match_making, status)
         VALUES ('restart-node', 'TestA', true, true, 'Online')
         ON CONFLICT (id) DO NOTHING`,
      );
      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers (host, label, rcon_password, port, tv_port, enabled, connected, region, type, is_dedicated, game_server_node_id)
         VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, $2 + 1, true, true, 'TestA', 'Ranked', $3,
                 CASE WHEN $3 THEN NULL ELSE 'restart-node' END)
         RETURNING id::text AS id`,
        [
          `restart-${matchId}`,
          30000 + Math.floor(Math.random() * 20000),
          dedicated,
        ],
      );
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
        [matchId, server.id],
      );
      await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
        matchId,
        server.id,
      ]);
      return server.id;
    };

    const serverRow = async (serverId: string) => {
      const [row] = await postgres.query<
        Array<{
          reserved_by_match_id: string | null;
          draining_match_id: string | null;
          check_due: boolean | null;
        }>
      >(
        `SELECT reserved_by_match_id::text, draining_match_id::text,
                draining_check_at <= now() AS check_due
           FROM servers WHERE id = $1`,
        [serverId],
      );
      return row;
    };

    it("drains the old on-demand server like an ended match's", async () => {
      const { match } = await vetoMatch(3, 2);
      const serverId = await onServer(match.id, false);

      await service().restartMatch(match.id, admin);

      expect(await serverRow(serverId)).toEqual({
        reserved_by_match_id: null,
        draining_match_id: match.id,
        check_due: true,
      });
      expect(refreshed).toEqual([serverId]);
      expect(streamsStopped).toEqual([match.id]);
    });

    it("frees a dedicated server and tells it to drop the game", async () => {
      const { match } = await vetoMatch(3, 2);
      const serverId = await onServer(match.id, true);

      await service().restartMatch(match.id, admin);

      expect(await serverRow(serverId)).toEqual({
        reserved_by_match_id: null,
        draining_match_id: null,
        check_due: null,
      });
      expect(refreshed).toEqual([serverId]);
    });

    it("leaves a server alone that is already another match's", async () => {
      const { match } = await vetoMatch(3, 2);
      const serverId = await onServer(match.id, false);
      const other = await fx.match();
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
        [other.id, serverId],
      );

      await service().restartMatch(match.id, admin);

      expect(await serverRow(serverId)).toEqual({
        reserved_by_match_id: other.id,
        draining_match_id: null,
        check_due: null,
      });
    });

    // assignOnDemandServer reserves the server, boots it, and only then writes
    // server_id. A restart in between leaves that reservation alone, so the
    // server_id written after it still points at a server the match holds.
    it("keeps the server an assignment in flight has reserved", async () => {
      const { match } = await vetoMatch(3, 2);
      const serverId = await onServer(match.id, false);
      await postgres.query(
        "UPDATE matches SET status = 'WaitingForServer', server_id = NULL WHERE id = $1",
        [match.id],
      );
      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $1 WHERE id = $2",
        [match.id, serverId],
      );

      await service().restartMatch(match.id, admin);

      expect(await serverRow(serverId)).toEqual({
        reserved_by_match_id: match.id,
        draining_match_id: null,
        check_due: null,
      });
      await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
        match.id,
        serverId,
      ]);
      const [after] = await postgres.query<
        Array<{ status: string; server_id: string }>
      >("SELECT status, server_id::text FROM matches WHERE id = $1", [
        match.id,
      ]);
      expect(after).toEqual({
        status: "WaitingForCheckIn",
        server_id: serverId,
      });
    });

    it.each(["Canceled", "Veto", "WaitingForCheckIn", "Finished"])(
      "refuses a %s match and changes nothing",
      async (status) => {
        const { match } = await vetoMatch(3, 2);
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          match.id,
          status,
        ]);
        const before = await kept(match.id);

        await expect(service().restartMatch(match.id, admin)).rejects.toThrow();

        expect(await kept(match.id)).toEqual(before);
      },
    );
  });

  describe("putting a map back to a round", () => {
    // The live map from liveMatch, played on to round 5 with a backup and a
    // kill in every round, and round 6 under way.
    const fiveRounds = async () => {
      const live = await liveMatch();
      const { match, mapId } = live;
      await postgres.query(
        "UPDATE match_map_rounds SET backup_file = $2 WHERE match_map_id = $1",
        [mapId, backup(157864, "vexa", 4100)],
      );
      for (const round of [3, 4, 5]) {
        await postgres.query(
          `INSERT INTO match_map_rounds
             (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
              "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
              lineup_1_side, lineup_2_side, winning_side, backup_file)
           VALUES ($1, $2, $2, 0, 800, 800, now(), $3, 1, 'CT', 'TERRORIST', 'CT', $4)`,
          [mapId, round, 5 - round, backup(157864, "vexa", 4100)],
        );
      }
      for (const round of [1, 3, 4, 5, 6]) {
        await kill(match.id, mapId, round);
      }
      await postgres.query(
        "UPDATE match_maps SET lineup_1_timeouts_available = 0, lineup_2_timeouts_available = 1 WHERE id = $1",
        [mapId],
      );

      return live;
    };

    const kill = (matchId: string, mapId: string, round: number) =>
      fx.kill({ matchId, mapId }, steamId(157864), steamId(235177), {
        round,
      });

    const reset = (mapId: string, round: number) =>
      postgres.query("SELECT reset_match_map_to_round($1, $2)", [mapId, round]);

    const state = async (mapId: string) => {
      const [rounds] = await postgres.query<
        Array<{ live: Array<number>; undone: Array<number> }>
      >(
        `SELECT COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NULL), '{}') AS live,
                COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NOT NULL), '{}') AS undone
           FROM match_map_rounds WHERE match_map_id = $1`,
        [mapId],
      );
      const [kills] = await postgres.query<
        Array<{ live: Array<number>; undone: Array<number> }>
      >(
        `SELECT COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NULL), '{}') AS live,
                COALESCE(array_agg(round ORDER BY round) FILTER (WHERE deleted_at IS NOT NULL), '{}') AS undone
           FROM player_kills WHERE match_map_id = $1`,
        [mapId],
      );
      const [timeouts] = await postgres.query<
        Array<{ lineup_1: number; lineup_2: number }>
      >(
        `SELECT lineup_1_timeouts_available AS lineup_1, lineup_2_timeouts_available AS lineup_2
           FROM match_maps WHERE id = $1`,
        [mapId],
      );

      return { rounds, kills, timeouts };
    };

    const shown = async (mapId: string) => {
      const [row] = await postgres.query<
        Array<{ lineup_1: number; kills: number }>
      >(
        `SELECT lineup_1_score(mm) AS lineup_1,
                COALESCE((SELECT sum(kills) FROM player_match_map_stats WHERE match_map_id = mm.id), 0)::int AS kills
           FROM match_maps mm WHERE mm.id = $1`,
        [mapId],
      );
      return row;
    };

    it("shows the score and the scoreboard of the round it went back to", async () => {
      const { match, mapId } = await fiveRounds();

      await reset(mapId, 3);
      expect(await shown(mapId)).toEqual({ lineup_1: 3, kills: 3 });

      await reset(mapId, 5);
      expect(await shown(mapId)).toEqual({ lineup_1: 5, kills: 5 });

      await service().restartMatchMap(match.id, admin);
      expect(await shown(mapId)).toEqual({ lineup_1: 0, kills: 0 });
    });

    it("rolls back to a round and drops the round that was under way", async () => {
      const { mapId } = await fiveRounds();

      await reset(mapId, 3);

      expect(await state(mapId)).toEqual({
        rounds: { live: [1, 2, 3], undone: [4, 5] },
        kills: { live: [1, 2, 3], undone: [4, 5] },
        timeouts: { lineup_1: 2, lineup_2: 1 },
      });
    });

    it("refuses a round the map doesn't have, and changes nothing", async () => {
      const { mapId } = await fiveRounds();
      const before = await state(mapId);

      await expect(reset(mapId, 9)).rejects.toMatchObject({
        code: "P0002",
        message: "there is no round 9 on this map to go back to",
      });

      expect(await state(mapId)).toEqual(before);
    });

    it("rolls forward again until the next round is played, without counting the replayed round twice", async () => {
      const { match, mapId } = await fiveRounds();
      await reset(mapId, 3);
      await kill(match.id, mapId, 4);

      await reset(mapId, 5);

      expect(await state(mapId)).toEqual({
        rounds: { live: [1, 2, 3, 4, 5], undone: [] },
        kills: { live: [1, 2, 3, 4, 5], undone: [] },
        timeouts: { lineup_1: 0, lineup_2: 1 },
      });
    });

    // How a restore to round 3 leaves the map: rounds 4 and 5 are undone, but
    // kept until round 4 is played again.
    it("can still go forward to a round an earlier restore undid", async () => {
      const { match, mapId } = await fiveRounds();
      await postgres.query(
        "UPDATE match_map_rounds SET deleted_at = now() WHERE match_map_id = $1 AND round > 3",
        [mapId],
      );
      const sent: Array<number> = [];

      const restore = await service(sent).getRestoreRounds(match.id, admin);
      await service(sent).restoreRound(match.id, 5, admin);

      expect(restore.live_round).toBe(4);
      expect(
        restore.rounds.map((round) => [round.round, round.undone]),
      ).toEqual([
        [1, false],
        [2, false],
        [3, false],
        [4, true],
        [5, true],
      ]);
      expect(sent).toEqual([5]);
    });

    it("restarts the map from warmup with every round still restorable", async () => {
      const { match, mapId } = await fiveRounds();
      const sent: Array<number> = [];

      await service(sent).restartMatchMap(match.id, admin);

      expect(await state(mapId)).toEqual({
        rounds: { live: [], undone: [1, 2, 3, 4, 5] },
        kills: { live: [], undone: [1, 2, 3, 4, 5] },
        timeouts: { lineup_1: 3, lineup_2: 3 },
      });

      const restore = await service(sent).getRestoreRounds(match.id, admin);
      expect(restore.live_round).toBe(1);
      expect(restore.restorable).toBe(true);
      expect(restore.rounds.map((round) => round.undone)).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);

      await postgres.query(
        "UPDATE match_maps SET status = 'Warmup' WHERE id = $1",
        [mapId],
      );
      await expect(
        service(sent).restoreRound(match.id, 4, admin),
      ).rejects.toThrow("the map isn't live yet");

      await postgres.query(
        "UPDATE match_maps SET status = 'Live' WHERE id = $1",
        [mapId],
      );
      await service(sent).restoreRound(match.id, 4, admin);
      expect(sent).toEqual([4]);
    });

    it("does the same when the whole match is restarted", async () => {
      const { match, mapId } = await fiveRounds();

      await service().restartMatch(match.id, admin);

      expect(await state(mapId)).toMatchObject({
        rounds: { live: [], undone: [1, 2, 3, 4, 5] },
        kills: { live: [], undone: [1, 2, 3, 4, 5] },
      });
    });
  });
});
