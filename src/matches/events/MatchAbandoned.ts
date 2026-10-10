import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchAbandoned extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    if (!(await this.isLineupMember())) {
      this.logger.warn(
        `[${this.matchId}] abandon refused: ${this.data.steam_id} is not in this match's lineups`,
      );
      return;
    }

    await this.hasura.mutation({
      insert_abandoned_matches_one: {
        __args: {
          object: {
            steam_id: this.data.steam_id,
            match_id: this.matchId,
          },
        },
        __typename: true,
      },
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
