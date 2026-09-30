import { Test } from "@nestjs/testing";
import { CaptainPickService } from "./captain-pick.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { EventEmitter } from "events";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { CaptainPickProgressController } from "./captain-pick-progress.controller";

describe("public Captain Pick SSE", () => {
  it("resyncs on connect, scopes push updates and tears down without mutations", async () => {
    const redis = Object.assign(new EventEmitter(), {
      subscribe: jest.fn(async () => {}),
    });
    let snapshot: any = {
      matchId: "m1",
      active: true,
      completed: false,
      progress: { pickIndex: 0 },
    };
    const captainPick = {
      getSpectatorProgress: jest.fn(async (matchId) => ({
        ...snapshot,
        matchId,
      })),
    };
    const controller = new CaptainPickProgressController(
      captainPick as any,
      { getConnection: () => redis } as any,
    );
    await controller.onModuleInit();
    const seen: any[] = [];
    const subscription = controller
      .progress("m1")
      .subscribe((event) => seen.push(event.data));
    await new Promise(setImmediate);
    expect(seen).toHaveLength(1);
    redis.emit(
      "message",
      "captain-pick-progress",
      JSON.stringify({ matchId: "m2" }),
    );
    redis.emit("message", "captain-pick-progress", "invalid");
    await new Promise(setImmediate);
    expect(seen).toHaveLength(1);
    snapshot = {
      matchId: "m1",
      active: true,
      completed: false,
      progress: { pickIndex: 1 },
    };
    redis.emit(
      "message",
      "captain-pick-progress",
      JSON.stringify({ matchId: "m1" }),
    );
    await new Promise(setImmediate);
    expect(seen.at(-1).progress.pickIndex).toBe(1);
    snapshot = {
      matchId: "m1",
      active: false,
      completed: true,
      progress: null,
    };
    redis.emit(
      "message",
      "captain-pick-progress",
      JSON.stringify({ matchId: "m1" }),
    );
    await new Promise(setImmediate);
    expect(seen.at(-1)).toEqual(snapshot);
    subscription.unsubscribe();
    const reconnected: any[] = [];
    const second = controller
      .progress("m1")
      .subscribe((event) => reconnected.push(event.data));
    await new Promise(setImmediate);
    expect(reconnected).toEqual([snapshot]);
    second.unsubscribe();
    expect(Reflect.getMetadata(METHOD_METADATA, controller.progress)).toBe(
      RequestMethod.GET,
    );
    controller.onModuleDestroy();
    expect(redis.listenerCount("message")).toBe(0);
  });
  it("serves anonymous GET SSE snapshots but has no mutation route", async () => {
    const redis = Object.assign(new EventEmitter(), {
      subscribe: jest.fn(async () => {}),
    });
    const captainPick = {
      getSpectatorProgress: jest.fn(async (matchId) => ({
        matchId,
        active: false,
        completed: false,
        progress: null,
      })),
    };
    const module = await Test.createTestingModule({
      controllers: [CaptainPickProgressController],
      providers: [
        { provide: CaptainPickService, useValue: captainPick },
        {
          provide: RedisManagerService,
          useValue: { getConnection: () => redis },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      await app.listen(0, "127.0.0.1");
      const url = await app.getUrl();
      const id = "11111111-1111-4111-8111-111111111111";
      const endpoint = url + "/matchmaking/captain-pick/" + id + "/progress";
      expect((await fetch(endpoint, { method: "POST" })).status).toBe(404);
      expect(
        (await fetch(url + "/matchmaking/captain-pick/invalid/progress"))
          .status,
      ).toBe(400);
      const response = await fetch(endpoint, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = response.body.getReader();
      let text = "";
      while (!text.includes("data:")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("SSE closed before its initial snapshot");
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('"matchId":"' + id + '"');
      expect(text).toContain('"progress":null');
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      abort.abort();
      await app.close();
    }
  });

  it("reconciles lost notifications or expired Redis state and cancels the timer on disconnect", async () => {
    jest.useFakeTimers();
    const redis = Object.assign(new EventEmitter(), {
      subscribe: jest.fn(async () => {}),
    });
    const captainPick = {
      getSpectatorProgress: jest.fn(async (matchId) => ({
        matchId,
        active: false,
        completed: false,
        progress: null,
      })),
    };
    const controller = new CaptainPickProgressController(
      captainPick as any,
      { getConnection: () => redis } as any,
    );
    const seen: any[] = [];
    const subscription = controller
      .progress("m1")
      .subscribe((event) => seen.push(event.data));
    await jest.advanceTimersByTimeAsync(30000);
    expect(captainPick.getSpectatorProgress).toHaveBeenCalledTimes(2);
    expect(seen.at(-1).progress).toBeNull();
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
    controller.onModuleDestroy();
    jest.useRealTimers();
  });
});
