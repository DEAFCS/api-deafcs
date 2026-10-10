import { Injectable, Logger, Scope } from "@nestjs/common";
import { HasuraService } from "../../../hasura/hasura.service";
import { MatchAssistantService } from "../../match-assistant/match-assistant.service";
import { ChatService } from "../../../chat/chat.service";
import { NotificationsService } from "../../../notifications/notifications.service";
import { PostgresService } from "../../../postgres/postgres.service";
import { DisconnectBudgetService } from "../../disconnect-budget/disconnect-budget.service";

import type { players_on_conflict } from "../../../../generated";

@Injectable({ scope: Scope.REQUEST })
export default abstract class MatchEventProcessor<T> {
  protected data: T;
  protected matchId: string;
  protected messageId?: string;

  constructor(
    protected readonly logger: Logger,
    protected readonly hasura: HasuraService,
    protected readonly matchAssistant: MatchAssistantService,
    protected readonly chat: ChatService,
    protected readonly notifications: NotificationsService,
    protected readonly postgres: PostgresService,
    protected readonly disconnectBudget: DisconnectBudgetService,
  ) {}

  public setData(matchId: string, data: T, messageId?: string) {
    this.data = data;
    this.matchId = matchId.trim();
    this.messageId = messageId;
  }

  public abstract process(): Promise<void>;

  // Upstream bf9edfa: only refresh unregistered names in this match.
  protected playerNameConflict(): players_on_conflict {
    return {
      constraint: "players_steam_id_key",
      update_columns: ["name"],
      where: {
        _or: [
          { name_registered: { _is_null: true } },
          { name_registered: { _eq: false } },
        ],
        player_lineup: { lineup: { match_id: { _eq: this.matchId } } },
      },
    };
  }
}
