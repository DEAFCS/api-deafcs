import {
  ConnectedSocket,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { Request } from "express";
import { FiveStackWebSocketClient } from "./types/FiveStackWebSocketClient";
import { SocketsService } from "./sockets.service";
import { WebsiteRestrictionsService } from "src/website-restrictions/website-restrictions.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class SocketsGateway implements OnGatewayConnection {
  constructor(
    private readonly sockets: SocketsService,
    private readonly websiteRestrictions: WebsiteRestrictionsService,
  ) {}

  @SubscribeMessage("ping")
  public async handleMessage(client: FiveStackWebSocketClient): Promise<void> {
    if (!client.user) {
      return;
    }

    await this.sockets.updateClient(client.user.steam_id, client.id);
  }

  public async handleConnection(
    @ConnectedSocket() client: FiveStackWebSocketClient,
    request: Request,
  ) {
    await this.sockets.setupSocket(client, request);
    if (client.user?.steam_id) {
      client.send(
        JSON.stringify({
          event: "account:restriction-status",
          data: await this.websiteRestrictions.getStatus(client.user.steam_id),
        }),
      );
    }
  }
}
