import {
  Controller,
  Header,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Sse,
} from "@nestjs/common";
import { concatMap, filter, interval, map, merge, of, Subject } from "rxjs";
import { Redis } from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { CaptainPickService } from "./captain-pick.service";

/** Public observation only. No access to the authenticated website socket or actions. */
@Controller("matchmaking/captain-pick")
export class CaptainPickProgressController
  implements OnModuleInit, OnModuleDestroy
{
  private readonly changes = new Subject<string>();
  private readonly subscriber: Redis;
  private readonly onMessage = (channel: string, matchId: string) => {
    if (channel !== "captain-pick-progress") return;
    try {
      const data = JSON.parse(matchId);
      if (typeof data.matchId === "string") this.changes.next(data.matchId);
    } catch {
      /* Ignore malformed invalidations; reconciliation reads Redis. */
    }
  };

  constructor(
    private readonly captainPick: CaptainPickService,
    redisManager: RedisManagerService,
  ) {
    this.subscriber = redisManager.getConnection("sub");
  }

  async onModuleInit() {
    this.subscriber.on("message", this.onMessage);
    await this.subscriber.subscribe("captain-pick-progress");
  }

  onModuleDestroy() {
    this.subscriber.off("message", this.onMessage);
    this.changes.complete();
  }

  @Sse(":matchId/progress")
  @Header("X-Accel-Buffering", "no")
  progress(@Param("matchId", new ParseUUIDPipe()) matchId: string) {
    // Picks/completion are pushed. A slow reconciliation also keeps the stream
    // alive through proxies and clears state after Redis TTL expiry/lost pubsub.
    // Reconnecting always starts with a fresh Redis snapshot.
    return merge(
      of(matchId),
      this.changes.pipe(filter((id) => id === matchId)),
      interval(30000).pipe(map(() => matchId)),
    ).pipe(
      concatMap(() => this.captainPick.getSpectatorProgress(matchId)),
      map((data): MessageEvent => ({ data })),
    );
  }
}
