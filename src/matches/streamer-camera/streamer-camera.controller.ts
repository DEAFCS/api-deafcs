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
import { StreamerCameraService } from "./streamer-camera.service";
import { User } from "../../auth/types/User";

// Reads the raw request body as text -- WHIP/WHEP bodies are
// application/sdp, which Nest's default body parsers don't claim (see
// CameraController for the same helper / same reasoning).
function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

@Controller("matches/streamer-camera")
export class StreamerCameraController {
  constructor(private readonly streamerCamera: StreamerCameraService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // --- Player-facing: publishes the logged-in player's own camera ---

  @Post(":matchId/publish/whip")
  public async publishWhip(
    @Param("matchId") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.streamerCamera.proxyPlayerWhip(
        matchId,
        user,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get(":matchId/publish/status")
  public async publishStatus(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    return this.streamerCamera.getPublishStatus(matchId, user);
  }

  // --- Streamer-facing: game-streamer's HUD overlay pulls from here ---
  // Gated by x-origin-auth (matchId:matchPassword), not a user session --
  // this is called by the game-streamer container, not a browser.

  @Post(":matchId/broadcast/:steamId/whep")
  public async broadcastWhep(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (
      !(await this.streamerCamera.validateBroadcastOriginAuth(
        matchId,
        request.headers["x-origin-auth"],
      ))
    ) {
      return response.status(401).end();
    }

    const sdp = await readRawBody(request);
    try {
      const answer = await this.streamerCamera.proxyBroadcastWhep(
        matchId,
        steamId,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }
}
