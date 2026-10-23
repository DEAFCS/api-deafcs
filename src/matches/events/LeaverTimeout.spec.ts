import { Logger } from "@nestjs/common";
import LeaverTimeout from "./LeaverTimeout";

describe("LeaverTimeout match ownership", () => {
  function setup(member: boolean) {
    const hasura = {
      query: jest.fn().mockImplementation(async (query) => {
        if (query.match_lineup_players) {
          return {
            match_lineup_players: member ? [{ id: "lineup-player" }] : [],
          };
        }
        return { matches_by_pk: { server_id: "server-1" } };
      }),
    };
    const disconnectBudget = { applyLeaverBan: jest.fn() };
    const logger = new Logger("test");
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    const processor = new LeaverTimeout(
      logger,
      hasura as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      disconnectBudget as any,
    );
    processor.setData("match-1", { steam_id: "player-1" });
    return { hasura, disconnectBudget, processor };
  }

  it("checks membership in this match's lineups", async () => {
    const { hasura, processor } = setup(true);
    await processor.process();
    expect(
      hasura.query.mock.calls[0][0].match_lineup_players.__args.where,
    ).toEqual({
      steam_id: { _eq: "player-1" },
      lineup: { match_id: { _eq: "match-1" } },
    });
  });

  it("bans a lineup member with the match's server", async () => {
    const { disconnectBudget, processor } = setup(true);
    await processor.process();
    expect(disconnectBudget.applyLeaverBan).toHaveBeenCalledWith({
      steamId: "player-1",
      serverId: "server-1",
      violation: "disconnect_timeout",
      matchId: "match-1",
    });
  });

  it("never bans a player outside this match", async () => {
    const { hasura, disconnectBudget, processor } = setup(false);
    await processor.process();
    expect(disconnectBudget.applyLeaverBan).not.toHaveBeenCalled();
    expect(hasura.query).toHaveBeenCalledTimes(1);
  });
});
