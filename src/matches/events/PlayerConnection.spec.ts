import PlayerConnected from "./PlayerConnected";
import PlayerDisconnected from "./PlayerDisconnected";

// match_lineup_players.is_connected is what Restore Round counts (connected
// players vs expected). The game server's player-connected and
// player-disconnected events keep it current (upstream 5stackgg/api #388);
// without them every lineup player read as not connected (0/2 in a live Duel).
describe("player connection events", () => {
  const postgres = { query: jest.fn(async () => []) };
  const hasura = { mutation: jest.fn(async () => ({})) };
  const chat = {
    joinLobbyViaGame: jest.fn(async () => undefined),
    leaveLobbyViaGame: jest.fn(async () => undefined),
  };

  const make = <T extends PlayerConnected | PlayerDisconnected>(
    Event: new (...args: Array<any>) => T,
  ) =>
    new Event(
      { log: jest.fn(), warn: jest.fn() } as never,
      hasura as never,
      {} as never,
      chat as never,
      {} as never,
      postgres as never,
      {} as never,
    );

  const isConnectedUpdates = () =>
    postgres.query.mock.calls
      .map(([sql, params]: [string, Array<unknown>]) => ({
        sql: sql.replace(/\s+/g, " "),
        params,
      }))
      .filter(({ sql }) => sql.includes("SET is_connected"));

  beforeEach(() => jest.clearAllMocks());

  it("marks the player connected in this match's lineups", async () => {
    const event = make(PlayerConnected);
    event.setData("match-1", {
      steam_id: "76561198000000001",
      player_name: "vexa",
    });
    await event.process();

    const [update] = isConnectedUpdates();
    expect(update.sql).toContain("SET is_connected = true");
    expect(update.sql).toContain(
      "(mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)",
    );
    expect(update.params).toEqual(["match-1", "76561198000000001"]);
    expect(chat.joinLobbyViaGame).toHaveBeenCalledWith(
      "match-1",
      "76561198000000001",
    );
  });

  it("marks the player not connected when they leave", async () => {
    const event = make(PlayerDisconnected);
    event.setData("match-1", { steam_id: "76561198000000001" });
    await event.process();

    const [update] = isConnectedUpdates();
    expect(update.sql).toContain("SET is_connected = false");
    expect(update.params).toEqual(["match-1", "76561198000000001"]);
    expect(chat.leaveLobbyViaGame).toHaveBeenCalledWith(
      "match-1",
      "76561198000000001",
    );
  });
});
