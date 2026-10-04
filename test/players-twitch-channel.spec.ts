import { PostgresService } from "../src/postgres/postgres.service";
import { TwitchStreamsService } from "../src/twitch/twitch-streams.service";
import { TWITCH_COUNTER_STRIKE_GAME_ID } from "../src/twitch/twitch.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.twitch_channel (migration 1878000024000) and the Twitch rules
// service's SQL against the real schema.
describe("players.twitch_channel", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("PlayersTwitchChannelTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199964000000n);
    // A match needs a region with a server (match veto prerequisite).
    await fx.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const setChannel = (steamId: string, channel: string | null) =>
    postgres.query("UPDATE players SET twitch_channel = $2 WHERE steam_id = $1", [steamId, channel]);

  it("is a nullable column that only accepts a normalized Twitch login", async () => {
    const steamId = await fx.player("Streamer");
    const [initial] = await postgres.query<Array<{ twitch_channel: string | null }>>(
      "SELECT twitch_channel FROM players WHERE steam_id = $1",
      [steamId],
    );
    expect(initial.twitch_channel).toBeNull();

    await setChannel(steamId, "tricon_2025");
    await setChannel(steamId, null);

    for (const bad of ["TricoN", "abc", "a".repeat(26), "tri-con", "https://twitch.tv/tricon", "tri con", ""]) {
      await expect(setChannel(steamId, bad)).rejects.toThrow(/players_twitch_channel_format/);
    }
  });

  it("the service updates only the caller's own row", async () => {
    const me = await fx.player("Me");
    const other = await fx.player("Other");
    await setChannel(other, "othersstream");
    const service = new TwitchStreamsService(postgres, { getStatuses: jest.fn(), getStatus: jest.fn() } as any);

    expect(await service.setOwnChannel(me, "https://www.twitch.tv/MyChannel/")).toEqual({ ok: true, channel: "mychannel" });
    const rows = await postgres.query<Array<{ steam_id: string; twitch_channel: string | null }>>(
      "SELECT steam_id::text, twitch_channel FROM players WHERE steam_id = ANY($1::bigint[]) ORDER BY name",
      [[me, other]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.steam_id, r.twitch_channel]))).toEqual({
      [me]: "mychannel",
      [other]: "othersstream",
    });
  });

  it("auto streams: seated players of a match in gameplay only; nothing for its own players/coach", async () => {
    const { matchId } = await fx.bareMatch();
    const [lineups] = await postgres.query<Array<{ lineup_1_id: string; lineup_2_id: string }>>(
      "SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1",
      [matchId],
    );
    const seated = await fx.lineupPlayer(lineups.lineup_1_id);
    await setChannel(seated, "seatedplayer");
    const coach = await fx.player("Coach");
    await postgres.query("UPDATE match_lineups SET coach_steam_id = $2 WHERE id = $1", [lineups.lineup_2_id, coach]);
    const outsider = await fx.player("Outsider");
    await setChannel(outsider, "outsiderstream");

    const twitch = {
      getStatus: jest.fn(),
      getStatuses: jest.fn(async (channels: string[]) =>
        Object.fromEntries(
          channels.map((channel) => [
            channel,
            {
              channel,
              live: true,
              available: true,
              streamId: "1",
              gameId: TWITCH_COUNTER_STRIKE_GAME_ID,
              gameName: "Counter-Strike",
              title: "live",
              checkedAt: "",
            },
          ]),
        ),
      ),
    };
    const service = new TwitchStreamsService(postgres, twitch as any);

    const povs = async () =>
      (await service.getMatchAutoStreams([matchId], null))[matchId].map((s) => s.channel);

    // Not live yet: nothing.
    expect(await povs()).toEqual([]);

    // Fixture shortcut: move the match/server through the lifecycle without
    // a real veto/server boot (the lifecycle triggers would demand both).
    // One multi-statement transaction, so it runs on a single connection.
    expect(matchId).toMatch(/^[0-9a-f-]{36}$/);
    const [server] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM servers WHERE label = 'TestA-server' LIMIT 1",
    );
    expect(server.id).toMatch(/^[0-9a-f-]{36}$/);
    const stage = (status: string, withServer: boolean, online: boolean) =>
      postgres.query(
        `BEGIN; SET LOCAL session_replication_role = replica;
         UPDATE servers SET connected = ${online} WHERE id = '${server.id}';
         UPDATE matches SET status = '${status}', server_id = ${withServer ? `'${server.id}'` : "NULL"} WHERE id = '${matchId}';
         COMMIT;`,
      );

    // Pre-match stages (ready check, Captain Pick, veto, waiting for a
    // server): manual streams only, never player POVs -- even with a server.
    for (const status of ["WaitingForCheckIn", "PickingPlayers", "Veto", "WaitingForServer"]) {
      await stage(status, true, true);
      expect(await povs()).toEqual([]);
    }
    // Live, but no server yet / the server still booting: still nothing.
    await stage("Live", false, false);
    expect(await povs()).toEqual([]);
    await stage("Live", true, false);
    expect(await povs()).toEqual([]);
    expect(twitch.getStatuses).not.toHaveBeenCalled();

    // Actual gameplay: Live with the server up.
    await stage("Live", true, true);

    const guest = await service.getMatchAutoStreams([matchId], null);
    // Only the seated player's channel, never the outsider's.
    expect(guest[matchId].map((s) => s.channel)).toEqual(["seatedplayer"]);
    expect(twitch.getStatuses).toHaveBeenLastCalledWith(["seatedplayer"]);

    expect((await service.getMatchAutoStreams([matchId], outsider))[matchId]).toHaveLength(1);
    // Anti-cheat: the match's own player and coach get nothing.
    expect((await service.getMatchAutoStreams([matchId], seated))[matchId]).toEqual([]);
    expect((await service.getMatchAutoStreams([matchId], coach))[matchId]).toEqual([]);

    // Finished: gone again.
    await stage("Finished", true, true);
    expect(await povs()).toEqual([]);
  });
});
