import { Logger } from "@nestjs/common";
import MatchAbandoned from "./MatchAbandoned";
describe("MatchAbandoned match ownership", () => {
  it.each([false, true])(
    "only records a lineup member (member=%s)",
    async (member) => {
      const hasura = {
        query: jest
          .fn()
          .mockResolvedValue({
            match_lineup_players: member ? [{ id: "lineup-player" }] : [],
          }),
        mutation: jest.fn(),
      };
      const logger = new Logger("test");
      jest.spyOn(logger, "warn").mockImplementation(() => {});
      const processor = new MatchAbandoned(
        logger,
        hasura as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      processor.setData("match-1", { steam_id: "player-1" });
      await processor.process();
      expect(
        hasura.query.mock.calls[0][0].match_lineup_players.__args.where,
      ).toEqual({
        steam_id: { _eq: "player-1" },
        lineup: { match_id: { _eq: "match-1" } },
      });
      expect(hasura.mutation).toHaveBeenCalledTimes(Number(member));
    },
  );
});
