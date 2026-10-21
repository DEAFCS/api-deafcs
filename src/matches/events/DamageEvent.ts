import MatchEventProcessor from "./abstracts/MatchEventProcessor";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export default class DamageEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  attacker_steam_id: bigint;
  attacker_team: string;
  attacker_location: string;
  attacker_location_coordinates: string;
  weapon: string;
  damage: number;
  damage_armor: number;
  health: number;
  armor: number;
  hitgroup: string;
  attacked_steam_id: bigint;
  attacked_team: string;
  attacked_location: string;
  attacked_location_coordinates: string;
  match_map_id: string;
}> {
  public async process() {
    const attacker_data = {
      attacker_team: this.data.attacker_team,
      attacker_steam_id: this.data.attacker_steam_id,
      attacker_location: this.data.attacker_location,
      attacker_location_coordinates: this.data.attacker_location_coordinates,
    };

    await this.hasura.mutation({
      insert_player_damages_one: {
        __args: {
          object: {
            // A game server redelivers an event with the same messageId until
            // it is acked. The messageId is the row id, so a replay hits the
            // primary key and is skipped instead of storing the damage twice.
            ...(UUID_RE.test(this.messageId ?? "") &&
            this.messageId !== NIL_UUID
              ? { id: this.messageId }
              : {}),
            time: new Date(this.data.time),
            match_id: this.matchId,
            round: this.data.round,
            match_map_id: this.data.match_map_id,
            with: this.data.weapon,

            ...(this.data.attacker_steam_id ? attacker_data : {}),

            attacked_steam_id: this.data.attacked_steam_id,
            attacked_team: this.data.attacked_team,
            attacked_location: this.data.attacked_location,

            damage: this.data.damage,
            damage_armor: this.data.damage_armor,
            health: this.data.health,
            armor: this.data.armor,

            hitgroup: this.data.hitgroup,
          },
          on_conflict: {
            constraint: "player_damages_pkey",
            update_columns: [],
          },
        },
        __typename: true,
      },
    });
  }
}
