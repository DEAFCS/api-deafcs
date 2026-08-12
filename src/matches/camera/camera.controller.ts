import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  Res,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { CameraService } from "./camera.service";
import { User } from "../../auth/types/User";

// Reads the raw request body as text. Deliberately not going through
// Nest's json/urlencoded body parsers (see main.ts) — WHIP/WHEP bodies
// are `application/sdp`, a content-type neither parser claims, so the
// stream is still untouched here.
function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

@Controller("matches/camera")
export class CameraController {
  constructor(private readonly camera: CameraService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // --- Player-facing: gated only by the secret token, no session ---
  // (a phone scanning a QR code has no deafcs.net login of its own).

  @Post("player/:token/whip")
  public async playerWhip(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.camera.proxyWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.camera.getStatusForToken(token);
  }

  // Player side of an admin video call: pull the admin's talk stream,
  // poll whether one is currently live, and hang up on it.

  @Post("player/:token/talk/whep")
  public async playerTalkWhep(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.camera.proxyPlayerTalkWhep(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/talk/status")
  public async playerTalkStatus(@Param("token") token: string) {
    return this.camera.getTalkStatusForToken(token);
  }

  @Post("player/:token/talk/hangup")
  public async playerTalkHangup(@Param("token") token: string) {
    await this.camera.hangupPlayerTalk(token);
    return { ok: true };
  }

  // --- Admin-facing: session-gated, organizer/administrator only ---

  @Post("admin/:matchId/:steamId/whep")
  public async adminWhep(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.camera.proxyAdminWhep(
        matchId,
        steamId,
        user,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("admin/:matchId/players")
  public async adminPlayers(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    if (!matchId) {
      throw new BadRequestException("matchId is required");
    }
    return this.camera.getPlayersWithCameraStatus(matchId, user);
  }

  // Admin side of a video call to one specific player.

  @Post("admin/:matchId/:steamId/talk/whip")
  public async adminTalkWhip(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.camera.proxyAdminTalkWhip(
        matchId,
        steamId,
        user,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("admin/:matchId/:steamId/talk/status")
  public async adminTalkStatus(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    return this.camera.getTalkStatusForAdmin(matchId, steamId, user);
  }

  @Post("admin/:matchId/:steamId/talk/hangup")
  public async adminTalkHangup(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    await this.camera.hangupAdminTalk(matchId, steamId, user);
    return { ok: true };
  }
}
