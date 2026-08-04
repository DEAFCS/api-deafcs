import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerDisconnected extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    await this.chat.leaveLobbyViaGame(this.matchId, this.data.steam_id);

    // Partial unique index on (match_id, steam_id) WHERE reconnected_at IS
    // NULL guarantees a player only ever has one open disconnect row per
    // match, so a duplicate "player-disconnected" event is a no-op here.
    await this.postgres.query(
      `INSERT INTO public.match_player_disconnects (match_id, steam_id)
       VALUES ($1, $2)
       ON CONFLICT (match_id, steam_id) WHERE reconnected_at IS NULL DO NOTHING`,
      [this.matchId, this.data.steam_id],
    );
  }
}
