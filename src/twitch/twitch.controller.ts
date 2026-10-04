import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { User } from "../auth/types/User";
import { parseMatchIds, TwitchStreamsService } from "./twitch-streams.service";

// Twitch integration. Everything Twitch-facing (credentials, app token,
// Helix calls) stays in TwitchService; these routes only return public data.
//
//   GET /twitch/players/:steamId   public  channel + live (profile icon/dot)
//   GET /twitch/me                 auth    my own channel (Profile Settings)
//   PUT /twitch/me                 auth    set/clear my own channel
//   GET /twitch/match-streams?matchIds=a,b
//                                  public  live CS2 POV streams of seated
//                                          players per match; empty for a
//                                          match the viewer plays/coaches in
@Controller("twitch")
export class TwitchController {
  constructor(private readonly streams: TwitchStreamsService) {}

  private viewer(request: Request): User | undefined {
    return request.user as User | undefined;
  }

  @Get("players/:steamId")
  public async getPlayer(@Param("steamId") steamId: string) {
    const player = await this.streams.getPlayerTwitch(String(steamId ?? ""));
    return (
      player ?? { channel: null, live: false, gameName: null, title: null, checkedAt: null }
    );
  }

  @Get("me")
  public async getMine(@Req() request: Request) {
    const user = this.viewer(request);
    if (!user?.steam_id) throw new ForbiddenException("authentication required");
    return { channel: await this.streams.getOwnChannel(String(user.steam_id)) };
  }

  @Put("me")
  public async setMine(
    @Req() request: Request,
    @Body() body: { channel?: unknown } | undefined,
  ) {
    const user = this.viewer(request);
    if (!user?.steam_id) throw new ForbiddenException("authentication required");
    const result = await this.streams.setOwnChannel(
      String(user.steam_id),
      body?.channel ?? null,
    );
    if ("error" in result) throw new BadRequestException({ error: result.error });
    return { channel: result.channel };
  }

  @Get("match-streams")
  public async getMatchStreams(
    @Req() request: Request,
    @Query("matchIds") matchIds: string | string[] | undefined,
  ) {
    const user = this.viewer(request);
    return {
      streams: await this.streams.getMatchAutoStreams(
        parseMatchIds(matchIds),
        user?.steam_id ? String(user.steam_id) : null,
      ),
    };
  }
}
