import { CaptainPickRecoveryController } from "./captain-pick-recovery.controller";

// DEAFCS: Reset Captain Pick's gate. The reset itself is captain-pick.service
// .spec.ts's "Reset Captain Pick".
describe("CaptainPickRecoveryController", () => {
  const MATCH = "33333333-3333-4333-8333-333333333333";

  const setup = ({
    organizer = true,
    status = "PickingPlayers",
    ownTournament = false,
  } = {}) => {
    const matchAssistant = { isOrganizer: jest.fn(async () => organizer) };
    const postgres = {
      query: jest.fn(async (sql: string) =>
        sql.includes("AS own")
          ? [{ own: ownTournament }]
          : sql.includes("FROM matches")
            ? [{ status }]
            : [],
      ),
    };
    const captainPick = {
      resetDraft: jest.fn(async (): Promise<void> => undefined),
    };
    return {
      controller: new CaptainPickRecoveryController(
        matchAssistant as never,
        postgres as never,
        captainPick as never,
      ),
      captainPick,
    };
  };

  const call = (
    controller: CaptainPickRecoveryController,
    role: string,
    expected?: number,
  ) =>
    controller.resetCaptainPick({
      match_id: MATCH,
      expected_picks: expected,
      user: { steam_id: "76561198000000001", role } as never,
    });

  it.each([
    ["administrator", false],
    ["match_organizer", false],
    ["tournament_organizer", true],
  ])("lets a %s reset", async (role, ownTournament) => {
    const { controller, captainPick } = setup({ ownTournament });

    await expect(call(controller, role, 3)).resolves.toEqual({
      success: true,
    });
    expect(captainPick.resetDraft).toHaveBeenCalledWith(
      MATCH,
      expect.objectContaining({ role }),
      3,
    );
  });

  it("refuses someone who doesn't organize the match", async () => {
    const { controller, captainPick } = setup({ organizer: false });

    await expect(call(controller, "administrator")).rejects.toThrow(
      "you are not a match organizer",
    );
    expect(captainPick.resetDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["user", false],
    ["moderator", false],
    ["tournament_organizer", false],
  ])(
    "refuses a %s who organizes the match but isn't staff for it",
    async (role, ownTournament) => {
      const { controller, captainPick } = setup({ ownTournament });

      await expect(call(controller, role)).rejects.toThrow(
        "only staff can reset the Captain Pick",
      );
      expect(captainPick.resetDraft).not.toHaveBeenCalled();
    },
  );

  it.each(["Veto", "Live", "Canceled", "WaitingForCheckIn"])(
    "refuses a %s match",
    async (status) => {
      const { controller, captainPick } = setup({ status });

      await expect(call(controller, "administrator")).rejects.toThrow(
        "the Captain Pick can only be reset while the captains pick",
      );
      expect(captainPick.resetDraft).not.toHaveBeenCalled();
    },
  );
});
