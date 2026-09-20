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

describe("MatchesController.callForOrganizer", () => {
  function makeController(matchOverrides: Record<string, any> = {}) {
    const controller = Object.create(MatchesController.prototype) as any;
    controller.appConfig = { webDomain: "https://example.com" };
    controller.hasura = {
      query: jest.fn().mockResolvedValue({
        matches_by_pk: {
          is_in_lineup: true,
          requested_organizer: false,
          ...matchOverrides,
        },
      }),
    };
    controller.notifications = {
      send: jest.fn(),
      sendSilent: jest.fn(),
    };
    return controller;
  }

  it("notifies match organizers and administrators, not a plain user role", async () => {
    const controller = makeController();

    await controller.callForOrganizer({
      user: { steam_id: "100" },
      match_id: "match-1",
    });

    expect(controller.notifications.send).toHaveBeenCalledWith(
      "MatchSupport",
      expect.objectContaining({
        title: "Match Assistanced Required",
        role: "match_organizer",
        entity_id: "match-1",
      }),
      undefined,
      expect.anything(),
    );
    expect(controller.notifications.sendSilent).toHaveBeenCalledWith(
      "MatchSupport",
      expect.objectContaining({
        title: "Match Assistanced Required",
        role: "administrator",
        entity_id: "match-1",
      }),
    );
    // No role other than match_organizer/administrator is ever targeted --
    // in particular never a bare "user" broadcast.
    expect(controller.notifications.send).not.toHaveBeenCalledWith(
      "MatchSupport",
      expect.objectContaining({ role: "user" }),
      undefined,
      expect.anything(),
    );
    // Exactly one broadcast per role -- not a duplicate.
    expect(controller.notifications.send).toHaveBeenCalledTimes(1);
    expect(controller.notifications.sendSilent).toHaveBeenCalledTimes(1);
  });

  it("does not re-notify once an organizer has already been requested", async () => {
    const controller = makeController({ requested_organizer: true });

    await controller.callForOrganizer({
      user: { steam_id: "100" },
      match_id: "match-1",
    });

    expect(controller.notifications.send).not.toHaveBeenCalled();
    expect(controller.notifications.sendSilent).not.toHaveBeenCalled();
  });
});
