import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class ChatMessageEvent extends MatchEventProcessor<{
  player: string;
  message: string;
  // Set by the game-server plugin when this came from say_team rather
  // than say (see PlayerChat.cs in both the CounterStrikeSharp and
  // Swiftly plugin variants). lineupId is the speaker's own
  // match_lineup_id, already resolved server-side by the plugin --
  // routes the message to that lineup's own private MatchTeam room
  // instead of the shared Match room every other message goes to.
  // Previously say_team was never even captured at all, so team chat
  // typed in-game silently never reached DEAFCS either way.
  teamOnly?: boolean;
  lineupId?: string;
}> {
  public async process() {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: this.data.player,
        },
        name: true,
        role: true,
        steam_id: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    if (!players_by_pk) {
      this.logger.warn("unable to find player", this.data.player);
      return;
    }

    if (this.data.teamOnly && this.data.lineupId) {
      await this.chat.sendMessageToChat(
        ChatLobbyType.MatchTeam,
        `${this.matchId}:${this.data.lineupId}`,
        players_by_pk,
        this.data.message,
        true,
        undefined,
        undefined,
        "game",
      );
      return;
    }

    await this.chat.sendMessageToChat(
      ChatLobbyType.Match,
      this.matchId,
      players_by_pk,
      this.data.message,
      true,
      undefined,
      undefined,
      "game",
    );
  }
}
