import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { e_notification_types_enum, e_player_roles_enum } from "generated";

type DueTournament = {
  id: string;
  name: string;
  start: string;
};

// Two independent reminder windows, each deduped the same way
// LeagueWeekReminders dedupes its own reminders: a distinct entity_id per
// (tournament, window) so a NOT EXISTS check against `notifications` is
// enough to guarantee each fires at most once, with no extra state needed
// on the tournaments table itself.
const WINDOWS: Array<{ suffix: string; hours: number; label: string }> = [
  { suffix: "1d", hours: 24, label: "starts in about a day" },
  { suffix: "2h", hours: 2, label: "starts in about 2 hours" },
];

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class TournamentReminders extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    let sent = 0;

    for (const window of WINDOWS) {
      const due = await this.postgres.query<DueTournament[]>(
        `SELECT t.id, t.name, t.start
           FROM tournaments t
          WHERE t.status IN ('RegistrationOpen', 'RegistrationClosed')
            AND t.start BETWEEN NOW() AND NOW() + ($1 || ' hours')::interval
            AND NOT EXISTS (
              SELECT 1 FROM notifications n
              WHERE n.type = 'TournamentReminder'
                AND n.entity_id = t.id::text || ':' || $2
            )`,
        [window.hours, window.suffix],
      );

      for (const tournament of due) {
        const steamIds = await this.postgres.query<Array<{ player_steam_id: string }>>(
          `SELECT DISTINCT player_steam_id FROM tournament_team_roster WHERE tournament_id = $1`,
          [tournament.id],
        );
        if (!steamIds.length) continue;

        await this.notifications.notifyPlayers(
          "TournamentReminder" as unknown as e_notification_types_enum,
          {
            title: "Tournament starting soon",
            message: `<b>${NotificationsService.escapeHtml(tournament.name)}</b> ${window.label}.`,
            role: "user" as e_player_roles_enum,
            entity_id: `${tournament.id}:${window.suffix}`,
            steamIds: steamIds.map((s) => String(s.player_steam_id)),
          },
        );
        sent++;
      }
    }

    if (sent > 0) {
      this.logger.log(`${sent} tournament start reminders sent`);
    }

    return sent;
  }
}
