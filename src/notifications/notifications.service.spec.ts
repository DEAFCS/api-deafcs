import { NotificationsService } from "./notifications.service";

describe("NotificationsService sanction notifications", () => {
  let service: NotificationsService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { query: jest.Mock };
  let queue: { add: jest.Mock };

  const admin = "76561190000000001";
  const player = "76561190000000002";
  const teammate = "76561190000000003";

  beforeEach(() => {
    hasura = {
      query: jest.fn().mockResolvedValue({ players_by_pk: { name: "Player" } }),
      mutation: jest.fn().mockResolvedValue({}),
    };
    postgres = {
      query: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue({}) };

    service = new NotificationsService(
      hasura as any,
      postgres as any,
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ webDomain: "https://deafcs.net" }) } as any,
      queue as any,
    );
  });

  // "isSystemIssuedBan" is looked up by sanction id -- default every test
  // to an admin-issued sanction (a real steam id, not SYSTEM_STEAM_ID/null)
  // unless a test explicitly wants the system-issued path.
  function mockAdminIssued() {
    postgres.query.mockResolvedValueOnce([
      { sanctioned_by_steam_id: admin },
    ]);
  }

  describe("notifyMatchPlayersOfSanction", () => {
    function mockTeammates() {
      postgres.query.mockResolvedValueOnce([{ steam_id: teammate }]);
    }

    it("notifies former teammates of an actual ban (existing behavior preserved)", async () => {
      mockAdminIssued();
      mockTeammates();

      await service.notifyMatchPlayersOfSanction({
        sanctionId: "s1",
        steamId: player,
        type: "ban",
        reason: "cheating",
      });

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          insert_notifications: expect.objectContaining({
            __args: expect.objectContaining({
              objects: [
                expect.objectContaining({
                  steam_id: teammate,
                  type: "PlayerSanctioned",
                  entity_id: player,
                }),
              ],
            }),
          }),
        }),
      );
    });

    it.each([
      "website_chat_mute",
      "website_restriction",
      "mute",
      "gag",
      "silence",
    ])(
      "sends zero third-party notifications for a %s sanction",
      async (type) => {
        // Not consulted at all once the type guard returns first -- if this
        // mock were ever read, the postgres.query call count assertion
        // below would fail as a signal that the guard order regressed.
        await service.notifyMatchPlayersOfSanction({
          sanctionId: "s1",
          steamId: player,
          type,
          reason: "spam",
        });

        expect(postgres.query).not.toHaveBeenCalled();
        expect(hasura.mutation).not.toHaveBeenCalled();
      },
    );

    it("does not notify teammates of a system-issued ban", async () => {
      postgres.query.mockResolvedValueOnce([
        { sanctioned_by_steam_id: null },
      ]);

      await service.notifyMatchPlayersOfSanction({
        sanctionId: "s1",
        steamId: player,
        type: "ban",
      });

      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("sends nothing when the sanctioned player has no recent teammates", async () => {
      mockAdminIssued();
      postgres.query.mockResolvedValueOnce([]);

      await service.notifyMatchPlayersOfSanction({
        sanctionId: "s1",
        steamId: player,
        type: "ban",
      });

      expect(hasura.mutation).not.toHaveBeenCalled();
    });
  });

  describe("notifyAdminsOfBan", () => {
    it("notifies admins of an actual ban", async () => {
      mockAdminIssued();

      await service.notifyAdminsOfBan({
        sanctionId: "s1",
        steamId: player,
        type: "ban",
        reason: "cheating",
      });

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          insert_notifications: expect.objectContaining({
            __args: expect.objectContaining({
              objects: [
                expect.objectContaining({
                  role: "administrator",
                  type: "PlayerSanctioned",
                }),
              ],
            }),
          }),
        }),
      );
    });

    it.each([
      "website_chat_mute",
      "website_restriction",
      "mute",
      "gag",
      "silence",
    ])(
      "does not notify admins for a %s sanction",
      async (type) => {
        await service.notifyAdminsOfBan({
          sanctionId: "s1",
          steamId: player,
          type,
        });

        expect(postgres.query).not.toHaveBeenCalled();
        expect(hasura.mutation).not.toHaveBeenCalled();
      },
    );
  });

  describe("notifyBannedPlayer (the sanctioned player's own notification)", () => {
    it("still notifies the banned player themselves", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { last_sign_in_at: "2026-01-01T00:00:00.000Z" },
      });

      await service.notifyBannedPlayer({
        sanctionId: "s1",
        steamId: player,
        type: "ban",
        reason: "cheating",
      });

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          insert_notifications: expect.objectContaining({
            __args: expect.objectContaining({
              objects: [
                expect.objectContaining({
                  steam_id: player,
                  role: "user",
                }),
              ],
            }),
          }),
        }),
      );
    });

    it.each([
      "website_chat_mute",
      "website_restriction",
      "mute",
      "gag",
      "silence",
    ])(
      "does not send this bell notification for a %s sanction (mute status has its own live push)",
      async (type) => {
        await service.notifyBannedPlayer({
          sanctionId: "s1",
          steamId: player,
          type,
        });

        expect(hasura.query).not.toHaveBeenCalled();
        expect(hasura.mutation).not.toHaveBeenCalled();
      },
    );
  });
});
