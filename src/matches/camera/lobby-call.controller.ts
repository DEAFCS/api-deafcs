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
import { LobbyCallService } from "./lobby-call.service";
import { User } from "../../auth/types/User";

function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

@Controller("matches/camera/lobby-call")
export class LobbyCallController {
  constructor(private readonly lobbyCall: LobbyCallService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // --- Session-gated: the caller's own logged-in tab ---

  @Post(":lobbyId/join")
  public async join(@Param("lobbyId") lobbyId: string, @Req() request: Request) {
    const user = this.requireUser(request);
    try {
      return await this.lobbyCall.join(lobbyId, user);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  @Get(":lobbyId/participants")
  public async participants(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return { participants: await this.lobbyCall.getParticipantsForUser(lobbyId, user) };
    } catch {
      return { participants: [] };
    }
  }

  @Post(":lobbyId/:steamId/whep")
  public async peerWhep(
    @Param("lobbyId") lobbyId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.lobbyCall.proxyPeerWhep(lobbyId, steamId, user, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  // --- Token-gated: the QR/popup join page, no session required ---
  // (matches CameraController's player/:token routes exactly).

  @Post("player/:token/whip")
  public async playerWhip(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.lobbyCall.proxyWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.lobbyCall.getStatusForToken(token);
  }

  // The QR/phone join page is a real two-way call, not a one-way
  // publish-only feed like the required-webcam feature's token join
  // page -- so it also needs to see & pull everyone else's video, and
  // has no session to do that with. Token-gated equivalents of
  // participants/:lobbyId and :lobbyId/:steamId/whep above.

  @Get("player/:token/participants")
  public async playerParticipants(@Param("token") token: string) {
    return {
      participants: await this.lobbyCall.getParticipantsForToken(token),
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
      const answer = await this.lobbyCall.proxyPeerWhepForToken(token, steamId, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Post("player/:token/hangup")
  public async playerHangup(@Param("token") token: string) {
    await this.lobbyCall.hangupForToken(token);
    return { ok: true };
  }
}
