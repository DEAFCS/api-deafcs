import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class LeaverTimeout extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    // DEAFCS: same membership guard as MatchAbandoned (upstream bf9edfa). A
    // leaver ban escalates and costs ELO, so a server may only report players
    // of its own match.
    if (!(await this.isLineupMember())) {
      this.logger.warn(
        `[${this.matchId}] leaver timeout refused: ${this.data.steam_id} is not in this match's lineups`,
      );
      return;
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: this.matchId },
        server_id: true,
      },
    });

    if (!match) {
      return;
    }

    await this.disconnectBudget.applyLeaverBan({
      steamId: this.data.steam_id,
      serverId: match.server_id,
      violation: "disconnect_timeout",
      matchId: this.matchId,
    });
  }

  private async isLineupMember() {
    const { match_lineup_players } = await this.hasura.query({
      match_lineup_players: {
        __args: {
          where: {
            steam_id: { _eq: this.data.steam_id },
            lineup: { match_id: { _eq: this.matchId } },
          },
          limit: 1,
        },
        id: true,
      },
    });
    return match_lineup_players.length > 0;
  }
}
