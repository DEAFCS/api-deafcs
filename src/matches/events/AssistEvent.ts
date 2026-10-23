import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class AssistEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  attacker_team: string;
  attacker_location: string;
  attacked_steam_id: bigint;
  attacked_team: string;
  flash: boolean;
  match_map_id: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_player_assists_one: {
        __args: {
          object: {
            time: new Date(this.data.time),
            match_map_id: this.data.match_map_id,

            match_id: this.matchId,
            round: this.data.round,

            attacker_steam_id: this.data.attacker_steam_id,
            attacker_team: this.data.attacker_team,

            attacked_steam_id: this.data.attacked_steam_id,
            attacked_team: this.data.attacked_team,

            flash: this.data.flash,
          },
          // A game server redelivers an event whose ack it missed (an API
          // restart mid-match). The row is already stored, so the replay is
          // acknowledged instead of failing on the primary key forever.
          on_conflict: {
            constraint: "player_assists_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }
}
