import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerDisconnected extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    // Leaving has to clear this, or Restore Round would count a player who
    // walked out as still in the server.
    // Upstream 5stackgg/api 9dbc5c78 (#388) sets it the same way through
    // Hasura; DEAFCS's generated client predates the column, so plain SQL
    // as for connected_at.
    await this.postgres.query(
      `UPDATE public.match_lineup_players mlp
          SET is_connected = false
         FROM public.matches m
        WHERE (mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)
          AND m.id = $1
          AND mlp.steam_id = $2`,
      [this.matchId, this.data.steam_id],
    );

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
