import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { e_objective_types_enum } from "../../../generated";

export default class ObjectiveEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  player_steam_id: bigint;
  type: e_objective_types_enum;
  match_map_id: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_player_objectives_one: {
        __args: {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            match_map_id: this.data.match_map_id,
            type: this.data.type,
            round: this.data.round,
            player_steam_id: this.data.player_steam_id,
          },
          // A game server redelivers an event whose ack it missed (an API
          // restart mid-match). The row is already stored, so the replay is
          // acknowledged instead of failing on the primary key forever.
          on_conflict: {
            constraint: "player_objectives_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }
}
