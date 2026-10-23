import { e_utility_types_enum } from "../../../generated";
import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class UtilityEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  location: string;
  type: e_utility_types_enum;
  match_map_id: string;
  attacker_location_coordinates: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_player_utility_one: {
        __args: {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            match_map_id: this.data.match_map_id,
            round: this.data.round,
            type: this.data.type,
            attacker_steam_id: this.data.attacker_steam_id,
            attacker_location_coordinates:
              this.data.attacker_location_coordinates,
          },
          // A game server redelivers an event whose ack it missed (an API
          // restart mid-match). The row is already stored, so the replay is
          // acknowledged instead of failing on the primary key forever.
          on_conflict: {
            constraint: "player_utility_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }
}
