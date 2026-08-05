import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { AppConfig } from "../../configs/types/AppConfig";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";
import { DisconnectBudgetService } from "../disconnect-budget/disconnect-budget.service";
import { RconService } from "../../rcon/rcon.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelExpiredMatches extends WorkerHost {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
    private readonly disconnectBudget: DisconnectBudgetService,
    private readonly rconService: RconService,
  ) {
    super();
    this.appConfig = this.configService.get<AppConfig>("app");
  }
  async process(): Promise<number> {
    const expiredMatches = await this.getExpiredNonTournamentMatches();

    // Whether to cancel or force-start depends on the specific player(s)
    // still missing, not on whether *someone* in the match connected. A
    // player who genuinely never touched the server is a no-show -- cancel
    // the whole match and ban them. Only once every roster player has
    // touched the server at least once (no no-shows left) does the match
    // "started" as far as the rules are concerned: force it past warmup into
    // the knife round instead, and let DisconnectBudgetSystem/
    // TeamEmptyForfeitSystem (which only start enforcing from the knife
    // round onward) take over from there for whoever's still missing.
    const matchesToCancel: typeof expiredMatches = [];

    for (const match of expiredMatches) {
      const lineupPlayers = [
        ...match.lineup_1.lineup_players,
        ...match.lineup_2.lineup_players,
      ];
      const hasNoShow = lineupPlayers.some(
        (player) => player.steam_id != null && player.connected_at == null,
      );

      if (!hasNoShow) {
        await this.forceStartMatch(match);
        continue;
      }

      await this.banNoShows(match);
      await this.announceCancellation(match);
      matchesToCancel.push(match);
    }

    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            id: {
              _in: matchesToCancel.map((match) => match.id),
            },
          },
          _set: {
            status: "Canceled",
          },
        },
        affected_rows: true,
      },
    });

    const tournamentMatches = await this.getTournamentMatches();
    for (const tournamentMatch of tournamentMatches) {
      await this.handleExpiredTournamentMatch(tournamentMatch);
    }

    const totalExpiredMatches =
      update_matches.affected_rows + tournamentMatches.length;
    if (totalExpiredMatches > 0) {
      this.logger.log(`processed ${totalExpiredMatches} expired matches`);
    }

    return totalExpiredMatches;
  }

  private async handleExpiredTournamentMatch(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    const hasReadyLineup = match.lineup_1.is_ready || match.lineup_2.is_ready;
    const isAdminMode = match.options?.match_mode === "admin";

    if (!hasReadyLineup && isAdminMode) {
      await this.requestOrganizerAttention(match.id);
      return;
    }

    await this.forfeitMatch(match);
  }

  private async forfeitMatch(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    const winningLineupId = this.getWinningLineupId(match);
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match.id,
          },
          _set: {
            status: "Forfeit",
            winning_lineup_id: winningLineupId,
          },
        },
        __typename: true,
      },
    });
  }

  private getWinningLineupId(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    if (match.lineup_1.is_ready) {
      return match.lineup_1.id;
    }

    if (match.lineup_2.is_ready) {
      return match.lineup_2.id;
    }

    // Neither side checked in. In auto mode there is no one watching the
    // bracket, so coin-toss a winner to keep the tournament moving rather
    // than stalling it (admin mode routes to a human instead).
    return Math.random() < 0.5 ? match.lineup_1.id : match.lineup_2.id;
  }

  private async requestOrganizerAttention(matchId: string) {
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            cancels_at: null,
          },
        },
        __typename: true,
      },
    });

    if (await this.hasPendingOrganizerNotification(matchId)) {
      return;
    }

    await this.notifications.send(
      "MatchSupport",
      {
        message: `Tournament match requires admin attention <a href="${this.appConfig.webDomain}/matches/${matchId}">${matchId}</a>`,
        title: "Tournament match requires attention",
        role: "tournament_organizer",
        entity_id: matchId,
      },
      undefined,
      DISCORD_COLORS.RED,
    );
  }

  private async hasPendingOrganizerNotification(matchId: string) {
    const { notifications_aggregate } = await this.hasura.query({
      notifications_aggregate: {
        __args: {
          where: {
            entity_id: { _eq: matchId },
            type: { _eq: "MatchSupport" },
            is_read: { _eq: false },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    return notifications_aggregate.aggregate.count > 0;
  }

  private async getTournamentMatches() {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                is_tournament_match: {
                  _eq: true,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
        },
        id: true,
        is_tournament_match: true,
        options: {
          match_mode: true,
        },
        lineup_1: {
          id: true,
          is_ready: true,
        },
        lineup_2: {
          id: true,
          is_ready: true,
        },
      },
    });

    return matches;
  }

  private async getExpiredNonTournamentMatches() {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _neq: "Canceled",
                },
              },
              {
                is_tournament_match: {
                  _eq: false,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
        },
        id: true,
        server_id: true,
        lineup_1: {
          lineup_players: {
            steam_id: true,
            connected_at: true,
          },
        },
        lineup_2: {
          lineup_players: {
            steam_id: true,
            connected_at: true,
          },
        },
      },
    });

    return matches;
  }

  private async forceStartMatch(
    match: Awaited<
      ReturnType<typeof this.getExpiredNonTournamentMatches>
    >[number],
  ) {
    if (!match.server_id) {
      this.logger.warn(
        `cannot force-start match=${match.id}, no server assigned`,
      );
      return;
    }

    try {
      const rcon = await this.rconService.connect(match.server_id);

      if (!rcon) {
        this.logger.warn(
          `cannot force-start match=${match.id}, unable to connect to server rcon`,
        );
        return;
      }

      await rcon.send("force_ready");
    } catch (error) {
      this.logger.error(`failed to force-start match=${match.id}`, error);
    } finally {
      await this.rconService.disconnect(match.server_id);
    }
  }

  // The game-server client only learns about match state through pushed
  // events (websocket, RCON get_match) or its own explicit triggers, not by
  // polling -- a plain DB status update never reaches an already-connected
  // server. This is what actually tells players in-game the match is gone,
  // instead of the server just silently dying once the pod gets torn down.
  //
  // Uses the console-only announce_no_show_cancel command instead of a raw
  // RCON `say` -- `say` shows up as unstyled "Console: ..." text with no
  // color support, while this routes through the plugin's own
  // colored/localized message pipeline.
  private async announceCancellation(
    match: Awaited<
      ReturnType<typeof this.getExpiredNonTournamentMatches>
    >[number],
  ) {
    if (!match.server_id) {
      return;
    }

    try {
      const rcon = await this.rconService.connect(match.server_id);

      if (!rcon) {
        return;
      }

      await rcon.send("announce_no_show_cancel");
    } catch (error) {
      this.logger.error(`failed to announce cancellation match=${match.id}`, error);
    } finally {
      await this.rconService.disconnect(match.server_id);
    }
  }

  private async banNoShows(
    match: Awaited<
      ReturnType<typeof this.getExpiredNonTournamentMatches>
    >[number],
  ) {
    const lineupPlayers = [
      ...match.lineup_1.lineup_players,
      ...match.lineup_2.lineup_players,
    ];

    const noShows = lineupPlayers.filter(
      (player) => player.steam_id != null && player.connected_at == null,
    );

    for (const player of noShows) {
      try {
        await this.disconnectBudget.applyLeaverBan({
          steamId: `${player.steam_id}`,
          serverId: match.server_id,
          violation: "no_show",
          matchId: match.id,
        });
      } catch (error) {
        this.logger.error(
          `failed to apply no-show ban match=${match.id} steam_id=${player.steam_id}`,
          error,
        );
      }
    }
  }
}
