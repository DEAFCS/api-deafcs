import {
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { WebsiteRestrictionsService } from "src/website-restrictions/website-restrictions.service";

@WebSocketGateway({
  path: "/ws/web",
})
export class RconGateway {
  constructor(
    private readonly rconService: RconService,
    private readonly websiteRestrictions: WebsiteRestrictionsService,
  ) {}

  @SubscribeMessage("rcon")
  async rconEvent(
    @MessageBody()
    data: {
      uuid: string;
      command: string;
      serverId: string;
    },
    @ConnectedSocket() client: FiveStackWebSocketClient,
  ) {
    if (
      !client.user ||
      !(await this.rconService.canAccessServer(data.serverId, client.user))
    ) {
      return;
    }

    if ((await this.websiteRestrictions.getStatus(client.user.steam_id)).active) {
      client.send(
        JSON.stringify({
          event: "rcon",
          data: {
            uuid: data.uuid,
            result: "Your DEAFCS account is restricted to read-only access.",
          },
        }),
      );
      return;
    }

    const rcon = await this.rconService.connect(data.serverId);

    if (!rcon) {
      client.send(
        JSON.stringify({
          event: "rcon",
          data: {
            uuid: data.uuid,
            result: "unable to connect to rcon",
          },
        }),
      );

      return;
    }

    client.send(
      JSON.stringify({
        event: "rcon",
        data: {
          uuid: data.uuid,
          command: data.command,
          result: await rcon.send(data.command),
        },
      }),
    );
  }
}
