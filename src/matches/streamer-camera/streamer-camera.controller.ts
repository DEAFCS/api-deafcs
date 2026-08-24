import { Controller, Post, Get, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { StreamerCameraService } from "./streamer-camera.service";

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

  // --- Player-facing: gated only by the secret token, no session ---
  // (mirrors CameraController's player/:token routes exactly).

  @Post("player/:token/whip")
  public async playerWhip(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.streamerCamera.proxyPlayerWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.streamerCamera.getStatusForToken(token);
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
