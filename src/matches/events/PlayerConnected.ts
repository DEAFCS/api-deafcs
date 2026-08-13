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
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name"],
            // Only refill `name` for a player who hasn't gone through
            // the registerName/approveNameChange flow yet -- otherwise
            // every match connect silently overwrote a deliberately
            // chosen, admin-approved display name back to whatever the
            // game server reports as the player's current Steam persona
            // name, making the name-change-request system pointless.
            where: {
              _or: [
                { name_registered: { _is_null: true } },
                { name_registered: { _eq: false } },
              ],
            },
          },
        },
        __typename: true,
      },
    });
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
