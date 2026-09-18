import { TypeSenseController } from "./type-sense.controller";

describe("TypeSenseController player_sanctions event -> co-player notification dispatch", () => {
  let controller: TypeSenseController;
  let notifications: { queueSanctionNotification: jest.Mock };
  let queue: { remove: jest.Mock; add: jest.Mock };
  let hasura: { query: jest.Mock };
  let typeSense: { updatePlayer: jest.Mock };

  const player = "76561190000000002";

  beforeEach(() => {
    notifications = { queueSanctionNotification: jest.fn().mockResolvedValue(undefined) };
    queue = {
      remove: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
    hasura = { query: jest.fn().mockResolvedValue({ match_lineup_players: [] }) };
    typeSense = { updatePlayer: jest.fn().mockResolvedValue(undefined) };

    controller = new TypeSenseController(
      {} as any, // cache
      hasura as any,
      typeSense as any,
      notifications as any,
      { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as any,
      queue as any, // TypeSenseQueues.TypeSense
      { add: jest.fn() } as any, // PlayerReindex queue
      { add: jest.fn() } as any, // CheckSteamBans queue
      {} as any, // redisManager
      {} as any, // playerReindex
      {} as any, // playerEloRecompute
    );
  });

  it.each(["ban", "website_chat_mute", "mute", "gag", "silence"])(
    "queues the co-player notification job on INSERT for a %s sanction (type filtering happens inside NotificationsService)",
    async (type) => {
      await controller.player_sanctions({
        op: "INSERT",
        old: {} as any,
        new: {
          id: "s1",
          player_steam_id: player,
          type,
          reason: null,
        } as any,
      });

      expect(notifications.queueSanctionNotification).toHaveBeenCalledWith(
        expect.objectContaining({ steamId: player, type }),
      );
    },
  );

  it.each(["ban", "website_chat_mute", "mute", "gag", "silence"])(
    "does NOT queue a notification job on early unmute/unsanction (UPDATE soft-delete) for a %s sanction",
    async (type) => {
      await controller.player_sanctions({
        op: "UPDATE",
        old: {
          id: "s1",
          player_steam_id: player,
          type,
          deleted_at: null,
        } as any,
        new: {
          id: "s1",
          player_steam_id: player,
          type,
          deleted_at: "2026-09-19T00:00:00.000Z",
        } as any,
      });

      expect(notifications.queueSanctionNotification).not.toHaveBeenCalled();
    },
  );

  it("does not queue a notification job for a plain UPDATE that isn't a soft-delete (e.g. extending a mute's expiry)", async () => {
    await controller.player_sanctions({
      op: "UPDATE",
      old: {
        id: "s1",
        player_steam_id: player,
        type: "website_chat_mute",
        deleted_at: null,
        remove_sanction_date: "2026-09-19T00:00:00.000Z",
      } as any,
      new: {
        id: "s1",
        player_steam_id: player,
        type: "website_chat_mute",
        deleted_at: null,
        remove_sanction_date: "2026-09-20T00:00:00.000Z",
      } as any,
    });

    expect(notifications.queueSanctionNotification).not.toHaveBeenCalled();
  });
});
