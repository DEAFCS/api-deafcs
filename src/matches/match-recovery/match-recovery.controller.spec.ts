import { HasuraController } from "src/hasura/hasura.controller";
import { MatchRecoveryController } from "./match-recovery.controller";

describe("MatchRecoveryController", () => {
  const user = { steam_id: "76561198000000001" } as never;

  const setup = (organizer: boolean) => {
    const matchAssistant = { isOrganizer: jest.fn(async () => organizer) };
    const recovery = {
      getRestoreRounds: jest.fn(async () => ({ rounds: [] as Array<unknown> })),
      restoreRound: jest.fn(async () => ({ success: true })),
      restartMatch: jest.fn(async () => ({ success: true })),
      restartMatchMap: jest.fn(async () => ({ success: true })),
    };

    return {
      controller: new MatchRecoveryController(
        matchAssistant as never,
        recovery as never,
      ),
      recovery,
    };
  };

  it("keeps every action to the match's organizers", async () => {
    const { controller, recovery } = setup(false);

    await expect(
      controller.getMatchRestoreRounds({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restoreMatchRound({ match_id: "match-1", round: 4, user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restartMatch({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restartMatchMap({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");

    expect(recovery.getRestoreRounds).not.toHaveBeenCalled();
    expect(recovery.restoreRound).not.toHaveBeenCalled();
    expect(recovery.restartMatch).not.toHaveBeenCalled();
    expect(recovery.restartMatchMap).not.toHaveBeenCalled();
  });

  // DEAFCS: Restart Match is not a registered action, so even a request that
  // reaches the API's action endpoint directly never gets to the service.
  it("keeps Restart Match out of the action endpoint", async () => {
    const { controller, recovery } = setup(true);
    const hasura = new HasuraController(
      { error: jest.fn() } as never,
      {} as never,
      new Map([
        [
          "MatchesModule",
          {
            name: "MatchesModule",
            controllers: new Map([
              [
                MatchRecoveryController,
                { name: "MatchRecoveryController", instance: controller },
              ],
            ]),
          },
        ],
      ]) as never,
    );
    const call = (name: string) => {
      const response = { json: jest.fn(), status: jest.fn() };
      response.status.mockReturnValue(response);
      return hasura.actions(
        {
          user,
          body: { action: { name }, input: { match_id: "match-1" } },
        } as never,
        response as never,
      );
    };

    await call("restartMatchMap");
    expect(recovery.restartMatchMap).toHaveBeenCalledWith("match-1", user);

    await expect(call("restartMatch")).rejects.toThrow();
    expect(recovery.restartMatch).not.toHaveBeenCalled();
  });

  it("hands organizers' requests to the service", async () => {
    const { controller, recovery } = setup(true);

    await controller.getMatchRestoreRounds({ match_id: "match-1", user });
    await controller.restoreMatchRound({ match_id: "match-1", round: 4, user });
    await controller.restartMatch({ match_id: "match-1", user });
    await controller.restartMatchMap({ match_id: "match-1", user });

    expect(recovery.getRestoreRounds).toHaveBeenCalledWith("match-1", user);
    expect(recovery.restoreRound).toHaveBeenCalledWith("match-1", 4, user);
    expect(recovery.restartMatch).toHaveBeenCalledWith("match-1");
    expect(recovery.restartMatchMap).toHaveBeenCalledWith("match-1", user);
  });
});
