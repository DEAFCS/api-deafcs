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
      setMatchPaused: jest.fn(async () => ({ success: true })),
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
      controller.restartMatchMap({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.setMatchPaused({ match_id: "match-1", paused: true, user }),
    ).rejects.toThrow("you are not a match organizer");

    expect(recovery.getRestoreRounds).not.toHaveBeenCalled();
    expect(recovery.restoreRound).not.toHaveBeenCalled();
    expect(recovery.restartMatchMap).not.toHaveBeenCalled();
    expect(recovery.setMatchPaused).not.toHaveBeenCalled();
  });

  // DEAFCS: administrators only for now, organizer or not.
  it.each(["user", "moderator", "match_organizer", "tournament_organizer"])(
    "keeps Restart Match from a %s who organizes the match",
    async (role) => {
      const { controller, recovery } = setup(true);

      await expect(
        controller.restartMatch({
          match_id: "match-1",
          user: { steam_id: "76561198000000001", role } as never,
        }),
      ).rejects.toThrow("only administrators can restart a match");
      expect(recovery.restartMatch).not.toHaveBeenCalled();
    },
  );

  it("hands an administrator's Restart Match to the service", async () => {
    const { controller, recovery } = setup(false);
    const admin = {
      steam_id: "76561198000000002",
      role: "administrator",
    } as never;

    await controller.restartMatch({ match_id: "match-1", user: admin });

    expect(recovery.restartMatch).toHaveBeenCalledWith("match-1", admin);
  });

  // A request posted straight to the API's action endpoint, without Hasura's
  // role and type checks in front of it. The endpoint keeps the first
  // controller it resolves for each action, so these tests share one.
  describe("direct requests to the action endpoint", () => {
    const shared = setup(true);
    const organizer = (shared.controller as any).matchAssistant
      .isOrganizer as jest.Mock;
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
                {
                  name: "MatchRecoveryController",
                  instance: shared.controller,
                },
              ],
            ]),
          },
        ],
      ]) as never,
    );

    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const response = { json: jest.fn(), status: jest.fn() };
      response.status.mockReturnValue(response);
      await hasura.actions(
        {
          user,
          body: { action: { name }, input: { match_id: "match-1", ...input } },
        } as never,
        response as never,
      );
      return response;
    };

    beforeEach(() => {
      jest.clearAllMocks();
      organizer.mockResolvedValue(true);
    });

    it("refuses someone who isn't the match's organizer", async () => {
      organizer.mockResolvedValue(false);

      for (const name of [
        "getMatchRestoreRounds",
        "restoreMatchRound",
        "restartMatchMap",
        "setMatchPaused",
      ]) {
        const response = await call(name, { round: 4 });
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
          message: "you are not a match organizer",
        });
      }

      expect(shared.recovery.getRestoreRounds).not.toHaveBeenCalled();
      expect(shared.recovery.restoreRound).not.toHaveBeenCalled();
      expect(shared.recovery.restartMatchMap).not.toHaveBeenCalled();
      expect(shared.recovery.setMatchPaused).not.toHaveBeenCalled();
    });

    // DEAFCS: raw RCON is administrator-only (fc108eb1). An organizer gets the
    // predefined requests and nothing that carries a command of its own.
    it("gives an organizer no way to send a command of their own", async () => {
      await call("restoreMatchRound", { round: 4, command: "rcon_password x" });
      expect(shared.recovery.restoreRound).toHaveBeenCalledWith(
        "match-1",
        4,
        user,
      );

      // Pause takes a yes or no, never a command.
      await call("setMatchPaused", { paused: "sw_pause; rcon_password x" });
      expect(shared.recovery.setMatchPaused).toHaveBeenCalledWith(
        "match-1",
        false,
        user,
      );

      for (const name of ["rcon", "sendRcon", "rconCommand", "command"]) {
        await expect(call(name, { command: "status" })).rejects.toThrow();
      }
    });

    // DEAFCS: a request that reaches the endpoint directly still needs an
    // administrator, even from the match's organizer.
    it("keeps Restart Match to administrators", async () => {
      const response = await call("restartMatch");
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith({
        message: "only administrators can restart a match",
      });
      expect(shared.recovery.restartMatch).not.toHaveBeenCalled();
    });
  });

  it("hands organizers' requests to the service", async () => {
    const { controller, recovery } = setup(true);

    await controller.getMatchRestoreRounds({ match_id: "match-1", user });
    await controller.restoreMatchRound({ match_id: "match-1", round: 4, user });
    await controller.restartMatchMap({ match_id: "match-1", user });
    await controller.setMatchPaused({
      match_id: "match-1",
      paused: true,
      user,
    });

    expect(recovery.getRestoreRounds).toHaveBeenCalledWith("match-1", user);
    expect(recovery.restoreRound).toHaveBeenCalledWith("match-1", 4, user);
    expect(recovery.restartMatchMap).toHaveBeenCalledWith("match-1", user);
    expect(recovery.setMatchPaused).toHaveBeenCalledWith("match-1", true, user);
  });
});
