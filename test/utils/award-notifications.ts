import { PostgresService } from "../../src/postgres/postgres.service";

// Stand-in for NotificationsService in the SQL suites: notifyPlayers writes
// the same notifications rows the real one inserts through Hasura (so the
// AwardGranted duplicate check runs against real data), and can be told to
// fail to prove a failed notification never undoes a grant.
export function recordingNotifications(postgres: PostgresService) {
  const stub = {
    fail: false,
    notifyPlayers: jest.fn(
      async (
        type: string,
        notification: {
          title: string;
          message: string;
          role: string;
          entity_id?: string;
          steamIds: string[];
        },
      ) => {
        if (stub.fail) {
          throw new Error("notifications are down");
        }
        for (const steamId of new Set(notification.steamIds)) {
          await postgres.query(
            `INSERT INTO notifications (title, message, steam_id, role, type, entity_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              notification.title,
              notification.message,
              steamId,
              notification.role,
              type,
              notification.entity_id ?? null,
            ],
          );
        }
      },
    ),
  };
  return stub;
}

// AwardGranted rows per player, oldest first.
export async function awardNotifications(
  postgres: PostgresService,
): Promise<Array<{ steam_id: string; entity_id: string; message: string }>> {
  return postgres.query(
    `SELECT steam_id::text AS steam_id, entity_id, message
       FROM notifications
      WHERE type = 'AwardGranted'
      ORDER BY created_at, steam_id`,
  );
}

// grantAward and friends notify after the commit without awaiting it.
export async function settle(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for award notifications");
}
