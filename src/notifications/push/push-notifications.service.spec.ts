jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

import * as webPush from "web-push";
import { PushNotificationsService } from "./push-notifications.service";
import {
  NOTIFICATION_CATEGORY_KEYS,
  categoryForType,
  isCategoryEnabledByDefault,
  pushCategoryForType,
} from "./notification-categories";

const sendNotification = webPush.sendNotification as jest.Mock;

describe("PushNotificationsService", () => {
  const env = { ...process.env };
  let postgres: { query: jest.Mock };
  let logger: { warn: jest.Mock };

  const subscription = (id: string, steamId: string) => ({
    id,
    steam_id: steamId,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: "p256dh",
    auth: "auth",
  });

  function build(configured = true) {
    if (configured) {
      process.env.VAPID_PUBLIC_KEY = "public";
      process.env.VAPID_PRIVATE_KEY = "private";
    } else {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    }
    return new PushNotificationsService(logger as any, postgres as any);
  }

  const chat = {
    messageId: "message-1",
    type: "ChatMessage",
    title: "Sender in Cup",
    message: "hello <b>there</b>",
    entityId: "tournament:t-1",
    senderSteamId: "1",
  };

  beforeEach(() => {
    sendNotification.mockReset().mockResolvedValue({});
    postgres = { query: jest.fn().mockResolvedValue([]) };
    logger = { warn: jest.fn() };
  });

  afterAll(() => {
    process.env = env;
  });

  describe("sendChatMessage", () => {
    it("reads recipients and their push preference in one query, and sends the existing payload shape", async () => {
      postgres.query.mockResolvedValue([subscription("s-2", "2")]);
      const service = build();

      await service.sendChatMessage(["2"], chat);

      expect(postgres.query).toHaveBeenCalledTimes(1);
      const [sql, params] = postgres.query.mock.calls[0];
      expect(sql).toContain("public.push_subscriptions");
      expect(sql).toContain("public.push_notification_preferences");
      expect(sql).not.toMatch(/\binsert\b|\bupdate\b|public\.notifications\b/i);
      expect(params).toEqual([["2"], "chat", true]);

      expect(sendNotification).toHaveBeenCalledTimes(1);
      const [target, payload] = sendNotification.mock.calls[0];
      expect(target.endpoint).toContain("s-2");
      // Same fields handleNotificationInsert sends, which is all sw-push.js
      // and the notification click routing read.
      expect(JSON.parse(payload)).toEqual({
        title: "Sender in Cup",
        body: "hello there",
        type: "ChatMessage",
        entity_id: "tournament:t-1",
      });
    });

    it("keeps Global chat opt-in: no row means no push", async () => {
      const service = build();

      await service.sendChatMessage(["2"], {
        ...chat,
        type: "GlobalChatMessage",
        entityId: "global:global",
      });

      expect(postgres.query.mock.calls[0][1]).toEqual([
        ["2"],
        "global_chat",
        false,
      ]);
    });

    it.each([
      ["AnnouncementChatMessage", "announcement_chat", true],
      ["OrganizerChatMessage", "organizer_chat", true],
      ["ChatMessage", "chat", true],
    ])("%s uses the %s category (default %s)", async (type, key, enabled) => {
      const service = build();

      await service.sendChatMessage(["2"], { ...chat, type });

      expect(postgres.query.mock.calls[0][1]).toEqual([["2"], key, enabled]);
    });

    it("never pushes the sender, and pushes each recipient once", async () => {
      const service = build();

      await service.sendChatMessage(["1", "2", "2", "3"], chat);

      expect(postgres.query.mock.calls[0][1][0]).toEqual(["2", "3"]);
    });

    it("does nothing without recipients or without VAPID keys", async () => {
      await build().sendChatMessage(["1"], chat);
      await build(false).sendChatMessage(["2"], chat);

      expect(postgres.query).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("removes a subscription the push service says is gone", async () => {
      postgres.query.mockResolvedValueOnce([subscription("s-2", "2")]);
      sendNotification.mockRejectedValue({ statusCode: 410 });
      const service = build();

      await service.sendChatMessage(["2"], chat);

      expect(postgres.query).toHaveBeenLastCalledWith(
        "DELETE FROM public.push_subscriptions WHERE id = $1",
        ["s-2"],
      );
    });

    it("logs any other failure and still reaches the remaining devices", async () => {
      postgres.query.mockResolvedValueOnce([
        subscription("s-2", "2"),
        subscription("s-3", "3"),
      ]);
      sendNotification
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({});
      const service = build();

      await expect(service.sendChatMessage(["2", "3"], chat)).resolves.toBe(
        undefined,
      );

      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("timeout"),
      );
    });
  });

  describe("non-chat alerts", () => {
    it("still push from their notifications row", async () => {
      postgres.query
        .mockResolvedValueOnce([subscription("s-2", "2")])
        .mockResolvedValueOnce([]);
      const service = build();

      await service.handleNotificationInsert({
        steam_id: "2",
        role: "user",
        title: "Check-in is open",
        message: "Check in now",
        type: "TournamentReminder",
        entity_id: "t-1",
      });

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sendNotification.mock.calls[0][1])).toEqual(
        expect.objectContaining({ type: "TournamentReminder" }),
      );
    });
  });
});

// Phase A is written against 5Stack's pushCategoryForType contract. These
// pin what the move to upstream's notification_preferences relies on: every
// category a chat push uses is an existing push_notification_preferences
// key, so those rows copy across as (steam_id, 'push', category, enabled)
// with nothing to rename.
describe("push categories and the upstream preference model", () => {
  it("returns upstream's { key, defaultEnabled } shape", () => {
    expect(pushCategoryForType("ChatMessage")).toEqual({
      key: "chat",
      defaultEnabled: true,
    });
    expect(pushCategoryForType("NotAType")).toBeNull();
  });

  it.each([
    "ChatMessage",
    "MatchChatMessage",
    "GlobalChatMessage",
    "OrganizerChatMessage",
    "AnnouncementChatMessage",
  ])("%s maps to an existing, unchanged category key", (type) => {
    const category = pushCategoryForType(type);

    expect(NOTIFICATION_CATEGORY_KEYS).toContain(category?.key);
    expect(category?.key).toBe(categoryForType(type));
    expect(category?.defaultEnabled).toBe(
      isCategoryEnabledByDefault(category!.key),
    );
  });

  it("keeps Global and Match chat opt-in", () => {
    expect(pushCategoryForType("GlobalChatMessage")?.defaultEnabled).toBe(
      false,
    );
    expect(pushCategoryForType("MatchChatMessage")?.defaultEnabled).toBe(
      false,
    );
  });
});
