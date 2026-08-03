import { User } from "../auth/types/User";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";

@Injectable()
export class FriendsService {
  private readonly steamApiKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    this.steamApiKey = this.config.get("steam.steamApiKey");
  }

  public async syncSteamFriends(user: User): Promise<boolean> {
    const response = await fetch(
      `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${this.steamApiKey}&steamid=${user.steam_id}`,
    );
    const { friendslist } = await response.json();
    const friends = friendslist?.friends.map((friend: { steamid: string }) => {
      return friend.steamid;
    });

    if (!friends || friends.length === 0) {
      return;
    }

    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: {
              _in: friends,
            },
            // Only auto-add Steam friends who have actually signed in on
            // deafcs.net themselves — otherwise being Steam friends with
            // someone the panel merely knows about (e.g. a shadow player
            // row from an imported match) wrongly shows them as an
            // "Accepted" in-app friend.
            last_sign_in_at: {
              _is_null: false,
            },
          },
        },
        steam_id: true,
      },
    });

    for (const player of players) {
      await this.hasura.mutation({
        insert_friends: {
          __args: {
            objects: [
              {
                player_steam_id: user.steam_id,
                other_player_steam_id: player.steam_id,
                status: "Accepted",
              },
            ],
            on_conflict: {
              constraint: "friends_pkey",
              update_columns: ["status"],
            },
          },
          __typename: true,
        },
      });
    }

    return true;
  }
}
