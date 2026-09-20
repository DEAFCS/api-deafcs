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

  describe("sendMatchMapPauseNotification", () => {
    function insertedObjects() {
      return hasura.mutation.mock.calls
        .filter((call) => call[0]?.insert_notifications_one)
        .map((call) => call[0].insert_notifications_one.__args.object);
    }

    describe("non-tournament match", () => {
      it("notifies the organizer personally, plus match_organizer and administrator broadcasts", async () => {
        hasura.query
          .mockResolvedValueOnce({ tournament_brackets: [] })
          .mockResolvedValueOnce({
            matches_by_pk: {
              organizer_steam_id: player,
              organizer: { role: "verified_user" },
            },
          })
          .mockResolvedValueOnce({ settings_by_pk: null });

        await service.sendMatchMapPauseNotification("match-1");

        const objects = insertedObjects();
        expect(objects).toEqual([
          expect.objectContaining({ steam_id: player, role: "user" }),
          expect.objectContaining({ role: "match_organizer" }),
          expect.objectContaining({ role: "administrator" }),
        ]);
        // Exactly one row per audience -- no duplicates.
        expect(objects).toHaveLength(3);
      });

      it("skips the personal copy when the match organizer is themselves an administrator (no duplicate)", async () => {
        hasura.query
          .mockResolvedValueOnce({ tournament_brackets: [] })
          .mockResolvedValueOnce({
            matches_by_pk: {
              organizer_steam_id: admin,
              organizer: { role: "administrator" },
            },
          })
          .mockResolvedValueOnce({ settings_by_pk: null });

        await service.sendMatchMapPauseNotification("match-1");

        const objects = insertedObjects();
        // Only the broadcasts -- the personal "user" copy for this admin is
        // skipped since they already get the administrator broadcast.
        expect(objects).toEqual([
          expect.objectContaining({ role: "match_organizer" }),
          expect.objectContaining({ role: "administrator" }),
        ]);
        expect(objects).toHaveLength(2);
        expect(objects.filter((o) => o.steam_id === admin)).toHaveLength(0);
      });
    });

    describe("tournament match", () => {
      const tournamentBrackets = (organizers: Array<{ steam_id: string; role: string }>) => ({
        tournament_brackets: [
          {
            stage: {
              tournament: {
                id: "t1",
                name: "Cup",
                organizer_steam_id: organizers[0].steam_id,
                admin: { role: organizers[0].role },
                organizers: organizers.slice(1).map((o) => ({
                  steam_id: o.steam_id,
                  organizer: { role: o.role },
                })),
                discord_notifications_enabled: false,
                discord_webhook: null,
                discord_role_id: null,
                discord_notify_MapPaused: false,
              },
            },
          },
        ],
      });

      it("notifies every tournament organizer plus a single administrator broadcast", async () => {
        hasura.query.mockResolvedValueOnce(
          tournamentBrackets([{ steam_id: player, role: "tournament_organizer" }]),
        );

        await service.sendMatchMapPauseNotification("match-1");

        const objects = insertedObjects();
        expect(objects).toEqual([
          expect.objectContaining({
            steam_id: player,
            role: "tournament_organizer",
          }),
          expect.objectContaining({ role: "administrator" }),
        ]);
        expect(objects).toHaveLength(2);
      });

      it("skips the personal tournament_organizer copy for an organizer who is also an administrator (no duplicate)", async () => {
        hasura.query.mockResolvedValueOnce(
          tournamentBrackets([
            { steam_id: admin, role: "administrator" },
            { steam_id: player, role: "tournament_organizer" },
          ]),
        );

        await service.sendMatchMapPauseNotification("match-1");

        const objects = insertedObjects();
        // The admin-organizer gets exactly the administrator broadcast, not
        // also a personal tournament_organizer row.
        expect(objects).toEqual([
          expect.objectContaining({
            steam_id: player,
            role: "tournament_organizer",
          }),
          expect.objectContaining({ role: "administrator" }),
        ]);
        expect(objects).toHaveLength(2);
        expect(
          objects.filter(
            (o) => o.steam_id === admin && o.role === "tournament_organizer",
          ),
        ).toHaveLength(0);
      });

      it("never targets an unauthorized role such as plain verified_user", async () => {
        hasura.query.mockResolvedValueOnce(
          tournamentBrackets([{ steam_id: player, role: "tournament_organizer" }]),
        );

        await service.sendMatchMapPauseNotification("match-1");

        const roles = insertedObjects().map((o) => o.role);
        for (const role of roles) {
          expect(["tournament_organizer", "administrator"]).toContain(role);
        }
      });
    });
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
