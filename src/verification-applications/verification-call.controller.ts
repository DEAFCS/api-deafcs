import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  Res,
  ForbiddenException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { VerificationCallService } from "./verification-call.service";
import { User } from "../auth/types/User";

function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

@Controller("verification-applications/call")
export class VerificationCallController {
  constructor(private readonly verificationCall: VerificationCallService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // Admin-only: rings the applicant (site-wide "Admin is calling..."
  // popup, see GlobalVerificationCallNotifier.vue). Authorization is
  // re-checked inside the service, not just here.
  @Post(":applicationId/ring")
  public async ring(
    @Param("applicationId") applicationId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      await this.verificationCall.ring(applicationId, user);
      return { ok: true };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  // Applicant-only: answers a ring, routed back to whichever admin is
  // waiting on it (see VerificationCallService.respondToRing).
  @Post(":applicationId/respond")
  public async respond(
    @Param("applicationId") applicationId: string,
    @Body() body: { accepted?: boolean },
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      await this.verificationCall.respondToRing(
        applicationId,
        user,
        body?.accepted === true,
      );
      return { ok: true };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  // --- Session-gated: the caller's own logged-in tab ---

  @Post(":applicationId/join")
  public async join(
    @Param("applicationId") applicationId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return await this.verificationCall.join(applicationId, user);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  @Get(":applicationId/participants")
  public async participants(
    @Param("applicationId") applicationId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return {
        participants: await this.verificationCall.getParticipantsForUser(
          applicationId,
          user,
        ),
      };
    } catch {
      return { participants: [] };
    }
  }

  @Post(":applicationId/:steamId/whep")
  public async peerWhep(
    @Param("applicationId") applicationId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.verificationCall.proxyPeerWhep(
        applicationId,
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
  // (matches LobbyCallController's player/:token routes exactly).

  @Post("player/:token/whip")
  public async playerWhip(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await readRawBody(request);
    try {
      const answer = await this.verificationCall.proxyWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.verificationCall.getStatusForToken(token);
  }

  @Get("player/:token/participants")
  public async playerParticipants(@Param("token") token: string) {
    return {
      participants: await this.verificationCall.getParticipantsForToken(token),
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
      const answer = await this.verificationCall.proxyPeerWhepForToken(
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
    await this.verificationCall.hangupForToken(token);
    return { ok: true };
  }
}
