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
import { TournamentCallService } from "./tournament-call.service";
import { User } from "../../auth/types/User";

function readRawBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

// Same route shapes as LobbyCallController, scoped to a tournament, plus
// a kick route. Every route re-checks access in TournamentCallService.
@Controller("matches/camera/tournament-call")
export class TournamentCallController {
  constructor(private readonly tournamentCall: TournamentCallService) {}

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }

  // --- Session-gated: the caller's own logged-in tab ---

  @Post(":tournamentId/join")
  public async join(
    @Param("tournamentId") tournamentId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return await this.tournamentCall.join(tournamentId, user);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  @Get(":tournamentId/participants")
  public async participants(
    @Param("tournamentId") tournamentId: string,
    @Req() request: Request,
  ) {
    const user = this.requireUser(request);
    try {
      return await this.tournamentCall.getParticipantsForUser(
        tournamentId,
        user,
      );
    } catch {
      return { participants: [] as unknown[], canKick: false };
    }
  }

  @Post(":tournamentId/kick/:steamId")
  public async kick(
    @Param("tournamentId") tournamentId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    try {
      await this.tournamentCall.kick(tournamentId, steamId, user);
      response.status(200).json({ ok: true });
    } catch (error) {
      response.status(403).json({ error: (error as Error).message });
    }
  }

  @Post(":tournamentId/:steamId/whep")
  public async peerWhep(
    @Param("tournamentId") tournamentId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await readRawBody(request);
    try {
      const answer = await this.tournamentCall.proxyPeerWhep(
        tournamentId,
        steamId,
        user,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response
        .status(400)
        .type("text/plain")
        .send((error as Error).message);
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
      const answer = await this.tournamentCall.proxyWhip(token, sdp);
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response
        .status(400)
        .type("text/plain")
        .send((error as Error).message);
    }
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.tournamentCall.getStatusForToken(token);
  }

  @Get("player/:token/participants")
  public async playerParticipants(@Param("token") token: string) {
    return {
      participants: await this.tournamentCall.getParticipantsForToken(token),
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
      const answer = await this.tournamentCall.proxyPeerWhepForToken(
        token,
        steamId,
        sdp,
      );
      response.status(200).type("application/sdp").send(answer);
    } catch (error) {
      response
        .status(400)
        .type("text/plain")
        .send((error as Error).message);
    }
  }

  @Post("player/:token/hangup")
  public async playerHangup(@Param("token") token: string) {
    await this.tournamentCall.hangupForToken(token);
    return { ok: true };
  }
}
