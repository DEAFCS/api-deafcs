import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerConnected extends MatchEventProcessor<{
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_players_one: {
        __args: {
          object: {
            name: this.data.player_name,
            steam_id: this.data.steam_id,
          },
          on_conflict: this.playerNameConflict(),
        },
        __typename: true,
      },
    });
    // Marks them as present. Cleared again on disconnect, so this always means
    // "in the server right now": what Restore Round's connected-players check
    // (MatchRecoveryService) reads.
    // Upstream 5stackgg/api 9dbc5c78 (#388) sets it the same way through
    // Hasura; DEAFCS's generated client predates the column, so plain SQL
    // as for connected_at.
    await this.postgres.query(
      `UPDATE public.match_lineup_players mlp
          SET is_connected = true
         FROM public.matches m
        WHERE (mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)
          AND m.id = $1
          AND mlp.steam_id = $2`,
      [this.matchId, this.data.steam_id],
    );
    await this.chat.joinLobbyViaGame(this.matchId, this.data.steam_id);

    await this.postgres.query(
      `UPDATE public.match_player_disconnects
          SET reconnected_at = now()
        WHERE match_id = $1
          AND steam_id = $2
          AND reconnected_at IS NULL`,
      [this.matchId, this.data.steam_id],
    );

    // First-ever connect for this player in this match — distinguishes a
    // genuine no-show (connected_at still NULL when the match auto-cancels)
    // from a player who joined and later disconnected.
    await this.postgres.query(
      `UPDATE public.match_lineup_players mlp
          SET connected_at = now()
         FROM public.matches m
        WHERE (mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)
          AND m.id = $1
          AND mlp.steam_id = $2
          AND mlp.connected_at IS NULL`,
      [this.matchId, this.data.steam_id],
    );
  }
}
