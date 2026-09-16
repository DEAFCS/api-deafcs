import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  Res,
  ForbiddenException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { AdminCallService } from "./admin-call.service";
import { User } from "../auth/types/User";

function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

@Controller("admin-calls")
export class AdminCallController {
  constructor(private readonly adminCall: AdminCallService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // Admin-only: rings the player (site-wide "Admin is calling..."
  // popup, see GlobalAdminCallNotifier.vue). Authorization is
  // re-checked inside the service, not just here.
  @Post(":targetSteamId/ring")
  public async ring(
    @Param("targetSteamId") targetSteamId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      await this.adminCall.ring(targetSteamId, user);
      return { ok: true };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  // --- Session-gated: the caller's own logged-in tab ---

  @Post(":targetSteamId/join")
  public async join(
    @Param("targetSteamId") targetSteamId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return await this.adminCall.join(targetSteamId, user);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  @Get(":targetSteamId/participants")
  public async participants(
    @Param("targetSteamId") targetSteamId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return {
        participants: await this.adminCall.getParticipantsForUser(
          targetSteamId,
          user,
        ),
      };
    } catch {
      return { participants: [] };
    }
  }

  @Post(":targetSteamId/:steamId/whep")
  public async peerWhep(
    @Param("targetSteamId") targetSteamId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.adminCall.proxyPeerWhep(
        targetSteamId,
        steamId,
        user,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  // --- Token-gated: the QR/popup join page, no session required ---

  @Post("player/:token/whip")
  public async playerWhip(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.adminCall.proxyWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.adminCall.getStatusForToken(token);
  }

  @Get("player/:token/participants")
  public async playerParticipants(@Param("token") token: string) {
    return {
      participants: await this.adminCall.getParticipantsForToken(token),
    };
  }

  @Post("player/:token/whep/:steamId")
  public async playerPeerWhep(
    @Param("token") token: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.adminCall.proxyPeerWhepForToken(
        token,
        steamId,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Post("player/:token/hangup")
  public async playerHangup(@Param("token") token: string) {
    await this.adminCall.hangupForToken(token);
    return { ok: true };
  }
}
