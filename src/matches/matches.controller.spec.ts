jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";

describe("MatchesController", () => {
  let controller: MatchesController;
  let matchAssistant: {
    isOrganizer: jest.Mock;
    rebootOnDemandServer: jest.Mock;
  };

  beforeEach(() => {
    matchAssistant = {
      isOrganizer: jest.fn(),
      rebootOnDemandServer: jest.fn(),
    };

    controller = new MatchesController(
      {} as any,
      {} as any,
      {} as any,
      {
        get: jest.fn(() => ({})),
      } as any,
      {} as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("rejects non-organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(false);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).rejects.toThrow("you are not a match organizer");

    expect(matchAssistant.rebootOnDemandServer).not.toHaveBeenCalled();
  });

  it("initiates a reboot for organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(true);
    matchAssistant.rebootOnDemandServer.mockResolvedValue(undefined);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).resolves.toEqual({ success: true });

    expect(matchAssistant.rebootOnDemandServer).toHaveBeenCalledWith("match-1");
  });
});

describe("MatchesController cancellation action", () => {
  it("rejects a direct unauthorized cancellation request", async () => {
    const controller = Object.create(MatchesController.prototype) as any;
    controller.matchAssistant = {
      canCancel: jest.fn().mockResolvedValue(false),
      updateMatchStatus: jest.fn(),
    };
    controller.terms = { assertAccepted: jest.fn() };

    await expect(
      controller.cancelMatch({
        match_id: "match-1",
        user: { steam_id: "200", role: "verified_user" },
      }),
    ).rejects.toThrow("you are not authorized to cancel this match");

    expect(controller.matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
  });

  it("updates the match only after authorization succeeds", async () => {
    const controller = Object.create(MatchesController.prototype) as any;
    controller.matchAssistant = {
      canCancel: jest.fn().mockResolvedValue(true),
      updateMatchStatus: jest.fn().mockResolvedValue(undefined),
    };
    controller.terms = { assertAccepted: jest.fn() };

    await expect(
      controller.cancelMatch({
        match_id: "match-1",
        user: { steam_id: "200", role: "match_organizer" },
      }),
    ).resolves.toEqual({ success: true });

    expect(controller.matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
      "match-1",
      "Canceled",
    );
  });
});
