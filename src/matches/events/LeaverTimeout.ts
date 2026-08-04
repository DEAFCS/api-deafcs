import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class LeaverTimeout extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
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
}
