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
      historyRequestId?: number;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user) {
      return;
    }

    await this.chat.joinMatchLobby(
      client,
      data.type,
      data.id,
      data.historyRequestId,
    );
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
      videoDraftId?: string;
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
    if (!client.user || (!data.message && !data.videoDraftId)) {
      return;
    }

    data.message = (data.message ?? "").trim();

    if (data.message.length === 0 && !data.videoDraftId) {
      return;
    }

    const result = await this.chat.sendMessageToChat(
      data.type,
      data.id,
      client.user,
      data.message,
      false,
      data.clientId,
      data.videoDraftId,
    );

    if (!result.accepted) {
      if (result.restrictionStatus) {
        client.send(
          JSON.stringify({
            event: "account:restriction-status",
            data: result.restrictionStatus,
          }),
        );
        client.send(
          JSON.stringify({
            event: "chat:send:error",
            data: { message: "Your account is restricted." },
          }),
        );
      }
      if (result.muteStatus) {
        client.send(
          JSON.stringify({
            event: "chat:mute-status",
            data: result.muteStatus,
          }),
        );
        client.send(
          JSON.stringify({
            event: "chat:send:error",
            data: { message: "You are muted from website chat." },
          }),
        );
      }
      return;
    }

    if (data.type !== ChatLobbyType.Match) {
      return;
    }

    if (!data.message || !data.message.length) return;
    await this.chat.sendChatToServer(
      data.id,
      `${isRoleAbove(client.user.role, "match_organizer") ? `[organizer] ` : ""}${client.user.name}: ${data.message}`.replaceAll(
        `"`,
        `'`,
      ),
    );
  }

  // Author-only, time-limited editing -- ChatService re-checks ownership,
  // age, room access, restriction and mute itself rather than trusting
  // this handler, same as every other permission check in chat living in
  // the service, not the gateway. Payloads without a type (older web
  // builds) are announcement edits. Never relayed to a game server.
  @SubscribeMessage("lobby:chat:edit")
  async editMessage(
    @MessageBody()
    data: {
      id: string;
      message: string;
      type?: ChatLobbyType;
      roomId?: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user || !data?.id || typeof data.message !== "string") {
      return;
    }

    if (!data.type || data.type === ChatLobbyType.Announcement) {
      await this.chat.editAnnouncement(client, data.id, data.message);
      return;
    }

    if (!data.roomId) {
      return;
    }

    await this.chat.editChatMessage(
      client,
      data.type,
      data.roomId,
      data.id,
      data.message,
    );
  }

  @SubscribeMessage("lobby:chat:reaction")
  async toggleReaction(
    @MessageBody()
    data: {
      id: string;
      type: ChatLobbyType;
      messageId: string;
      reaction: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (
      !client.user ||
      !data.id ||
      !data.type ||
      !data.messageId ||
      !data.reaction
    ) {
      return;
    }

    await this.chat.toggleChatMessageReaction(
      client,
      data.type,
      data.id,
      data.messageId,
      data.reaction,
    );
  }

  @SubscribeMessage("lobby:chat:delete")
  async deleteMessage(
    @MessageBody()
    data: { id: string; roomId: string; type: ChatLobbyType },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (!client.user || !data.id || !data.roomId || !data.type) {
      return;
    }

    await this.chat.deleteMessage(client, data.type, data.roomId, data.id);
  }
}
