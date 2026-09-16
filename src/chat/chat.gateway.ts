import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { ChatService } from "./chat.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { isRoleAbove } from "@utilities/isRoleAbove";

@WebSocketGateway({
  path: "/ws/web",
})
export class ChatGateway {
  constructor(private readonly chat: ChatService) {}

  @SubscribeMessage("lobby:join")
  async joinLobby(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user) {
      return;
    }

    await this.chat.joinMatchLobby(client, data.type, data.id);
  }

  @SubscribeMessage("lobby:leave")
  async leaveLobby(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user) {
      return;
    }

    void this.chat.removeFromLobby(data.type, data.id, client);
  }

  @SubscribeMessage("lobby:chat")
  async lobby(
    @MessageBody()
    data: {
      id: string;
      message: string;
      type: ChatLobbyType;
      // Per-browser-session id (see web-sockets/Socket.ts) -- echoed back
      // in the broadcast so a *different* session for the same account
      // (e.g. a PC browser while the phone sent this) can tell "my
      // account sent this" apart from "this exact tab/app sent this",
      // which is what the unread badge/sound need to check instead of
      // steam_id alone.
      clientId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!data.message) {
      return;
    }

    data.message = data.message.trim();

    if (data.message.length === 0) {
      return;
    }

    await this.chat.sendMessageToChat(
      data.type,
      data.id,
      client.user,
      data.message,
      false,
      data.clientId,
    );

    if (data.type !== ChatLobbyType.Match) {
      return;
    }

    await this.chat.sendChatToServer(
      data.id,
      `${isRoleAbove(client.user.role, "match_organizer") ? `[organizer] ` : ""}${client.user.name}: ${data.message}`.replaceAll(
        `"`,
        `'`,
      ),
    );
  }

  // Admin-only announcement editing -- ChatService re-checks the role
  // itself rather than trusting this handler, same as every other
  // permission check in chat living in the service, not the gateway.
  @SubscribeMessage("lobby:chat:edit")
  async editMessage(
    @MessageBody() data: { id: string; message: string },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user || !data.id || !data.message) {
      return;
    }

    await this.chat.editAnnouncement(client.user, data.id, data.message);
  }

  @SubscribeMessage("lobby:chat:delete")
  async deleteMessage(
    @MessageBody() data: { id: string },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user || !data.id) {
      return;
    }

    await this.chat.deleteAnnouncement(client.user, data.id);
  }
}
