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

  it("re-notifies on every call, no dedup on a prior request", async () => {
    // Deliberately no dedup (see callForOrganizer's own comment): a stale
    // unread MatchSupport notification used to leave the button stuck
    // disabled for the rest of the match, even once a new/different
    // problem came up later in the same live match.
    const controller = makeController();

    await controller.callForOrganizer({
      user: { steam_id: "100" },
      match_id: "match-1",
    });
    await controller.callForOrganizer({
      user: { steam_id: "100" },
      match_id: "match-1",
    });

    expect(controller.notifications.send).toHaveBeenCalledTimes(2);
    expect(controller.notifications.sendSilent).toHaveBeenCalledTimes(2);
  });
});

describe("MatchesController.checkIntoMatch authorization", () => {
  // can_check_in is evaluated by Postgres for the caller's own session
  // (can_check_in.sql): these cases stand for what it returns per
  // check_in_setting and role.
  const setup = (match: { status: string; can_check_in: boolean } | null) => {
    const controller = Object.create(MatchesController.prototype) as any;
    controller.terms = { assertAccepted: jest.fn() };
    // A refusal is checked for a pending starting-lineup confirmation first;
    // nothing is pending unless a test says so.
    controller.postgres = {
      query: jest.fn().mockResolvedValue([{ pending: false }]),
    };
    controller.hasura = {
      query: jest.fn().mockResolvedValue({ matches_by_pk: match }),
      mutation: jest.fn().mockResolvedValue({
        update_match_lineup_players: { affected_rows: 1 },
        update_matches: { affected_rows: 0 },
      }),
    };
    return controller;
  };
  const call = (controller: any, steamId = "76561198000000001") =>
    controller.checkIntoMatch({
      match_id: "match-1",
      user: { steam_id: steamId, role: "user" },
    });

  it.each([
    ["Players: a lineup player", true],
    ["Captains: the captain", true],
    ["Admin: an administrator in the lineup", true],
  ])("checks in when can_check_in allows it (%s)", async (_case, allowed) => {
    const controller = setup({
      status: "WaitingForCheckIn",
      can_check_in: allowed,
    });

    await expect(call(controller)).resolves.toEqual({ success: true });

    // Asked as the caller, not as the admin secret alone.
    expect(controller.hasura.query).toHaveBeenCalledWith(
      expect.objectContaining({
        matches_by_pk: expect.objectContaining({
          can_check_in: true,
          status: true,
        }),
      }),
      "76561198000000001",
    );
    expect(controller.hasura.mutation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Players: someone outside both lineups"],
    ["Captains: a lineup player who is not captain"],
    ["Admin: a lineup player who is not an administrator"],
    ["any setting: an organizer who is not in a lineup"],
  ])("rejects a direct call can_check_in refuses (%s)", async () => {
    const controller = setup({
      status: "WaitingForCheckIn",
      can_check_in: false,
    });

    await expect(call(controller)).rejects.toThrow(
      "you are not allowed to check in to this match",
    );
    expect(controller.hasura.mutation).not.toHaveBeenCalled();
  });

  it("still rejects matches that are not waiting for check-in, or missing", async () => {
    const live = setup({ status: "Live", can_check_in: false });
    await expect(call(live)).rejects.toThrow(
      "match is not accepting check in's at this time",
    );
    expect(live.hasura.mutation).not.toHaveBeenCalled();

    const missing = setup(null);
    await expect(call(missing)).rejects.toThrow(
      "match is not accepting check in's at this time",
    );
    expect(missing.hasura.mutation).not.toHaveBeenCalled();
  });

  it("keeps readiness on the lineups' own is_ready, and starts only when both are ready", async () => {
    const controller = setup({
      status: "WaitingForCheckIn",
      can_check_in: true,
    });
    await call(controller);
    const [, start] = controller.hasura.mutation.mock.calls;
    const where = start[0].update_matches.__args.where._and;
    expect(start[0].update_matches.__args._set).toEqual({ status: "Live" });
    expect(where).toEqual(
      expect.arrayContaining([
        { lineup_1: { is_ready: { _eq: true } } },
        { lineup_2: { is_ready: { _eq: true } } },
      ]),
    );
  });

  it("leaves the organizer's Start / Skip Check In on its own action", () => {
    const fs = jest.requireActual("fs");
    const path = jest.requireActual("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "matches.controller.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("public async checkIntoMatch("),
      source.indexOf("public async server_availability("),
    );
    expect(body).not.toMatch(
      /is_organizer: true|can_start: true|isOrganizer\(/,
    );
  });

  it("tells a team with substitutes to confirm its starting lineup instead of a bare refusal", async () => {
    const controller = setup({ status: "WaitingForCheckIn", can_check_in: false });
    controller.postgres.query.mockResolvedValue([{ pending: true }]);

    await expect(call(controller)).rejects.toThrow(
      "confirm the starting lineup before checking in",
    );
    expect(controller.hasura.mutation).not.toHaveBeenCalled();
  });
});

describe("can_check_in rules", () => {
  it("encodes Players / Captains / Admin as the action enforces them", () => {
    const fs = jest.requireActual("fs");
    const path = jest.requireActual("path");
    const sql = fs.readFileSync(
      path.resolve(__dirname, "../../hasura/functions/match/can_check_in.sql"),
      "utf8",
    );
    expect(sql).toContain("IF NOT is_in_lineup(match, hasura_session) THEN");
    expect(sql).toContain("IF match.status != 'WaitingForCheckIn' THEN");
    expect(sql).toMatch(
      /_check_in_setting = 'Admin' AND \(hasura_session ->> 'x-hasura-role'\)::text != 'administrator'/,
    );
    expect(sql).toMatch(
      /_check_in_setting = 'Captains' AND NOT is_captain\(match, hasura_session\)/,
    );
  });
});
