import path from "path";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createClient } from "../generated";
import { ChatService } from "../src/chat/chat.service";
import { ChatLobbyType } from "../src/chat/enums/ChatLobbyTypes";
import { User } from "../src/auth/types/User";
import {
  getCaptainPickDraftCacheKey,
  getMatchConfirmationKey,
} from "../src/matchmaking/utilities/cacheKeys";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootContainerAndMigrate,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Who may join (read) and post in a match's Match Chat, decided by the real
// Hasura engine with this repo's metadata and permission functions, the real
// ChatService and a real Redis.
//
// A matchmaking match has no organizer, and is_match_organizer is NULL (not
// false) for it. The join check used to compare with `=== false`, so it let
// any signed-in player into such a room.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";
const REDIS_IMAGE = "redis:7.4-alpine";
const DRAFT_ID = "88888888-8888-4888-8888-888888888888";

describe("Match Chat access (Postgres, Hasura, Redis)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasuraContainer: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let redis: Redis;
  let endpoint: string;
  let chat: ChatService;
  const adminSecret = "match-chat-access-local-test";

  // HasuraService.query: admin, or the player's own role and id.
  const hasura = {
    query: (request: any, steamId?: string) => run("query", request, steamId),
    mutation: (request: any, steamId?: string) =>
      run("mutation", request, steamId),
  };
  async function run(
    kind: "query" | "mutation",
    request: any,
    steamId?: string,
  ) {
    const headers: Record<string, string> = {
      "x-hasura-admin-secret": adminSecret,
    };
    if (steamId) {
      const [player] = await postgres.query<Array<{ role: string }>>(
        "SELECT role FROM players WHERE steam_id = $1",
        [steamId],
      );
      headers["x-hasura-role"] = player.role;
      headers["x-hasura-user-id"] = String(steamId);
    }
    const client = createClient({ url: `${endpoint}/v1/graphql`, headers });
    try {
      return await (client as any)[kind](request);
    } catch (error: any) {
      if (error?.response) throw error.response.errors.at(0).message;
      throw error;
    }
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MatchChatAccess");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199983000000n);
    await seedRegionWithServer(postgres, "TestA");

    const c = db.container!;
    hasuraContainer = await new GenericContainer(HASURA_IMAGE)
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: `postgres://${c.getUsername()}:${c.getPassword()}@host.docker.internal:${c.getPort()}/${c.getDatabase()}`,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .withStartupTimeout(240_000)
      .start();
    endpoint = `http://${hasuraContainer.getHost()}:${hasuraContainer.getMappedPort(8080)}`;

    redisContainer = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    redis = new Redis(
      redisContainer.getMappedPort(6379),
      redisContainer.getHost(),
    );

    chat = new ChatService(
      new Logger("MatchChatAccess"),
      { connect: async (): Promise<null> => null } as any,
      hasura as any,
      postgres,
      { getConnection: () => redis } as any,
      { notifyPlayers: jest.fn(), sendSilent: jest.fn() } as any,
      {
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
        hasBlocked: jest.fn().mockResolvedValue(false),
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        getViewersBlocking: jest.fn().mockResolvedValue(new Set()),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
    jest.spyOn(chat, "to").mockResolvedValue(undefined);
    jest.spyOn(chat as any, "notifyLobbyMembers").mockResolvedValue(undefined);
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await redisContainer?.stop();
    await hasuraContainer?.stop();
    await db?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  const player = async (role = "user") => {
    const steamId = await fx.player();
    if (role !== "user") {
      await postgres.query("UPDATE players SET role = $1 WHERE steam_id = $2", [
        role,
        steamId,
      ]);
    }
    return steamId;
  };

  // Only labels the stage: the join check reads status, nothing else here
  // depends on a real Live/Finished transition.
  const setStatus = (matchId: string, status: string) =>
    postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE matches SET status = $1 WHERE id = $2", [
        status,
        matchId,
      ]);
    });

  // A matchmaking match: no organizer, lineup 1 seated with `seated`.
  async function matchmakingMatch(seated: Array<string>) {
    const match = await fx.match();
    for (const steamId of seated) {
      await fx.lineupPlayer(match.lineup_1_id, steamId);
    }
    return match.id as string;
  }

  // Joins like the socket does; returns the history sent, or null if refused.
  async function join(matchId: string, steamId: string) {
    const socket = {
      id: `client-${steamId}`,
      user: { steam_id: steamId, name: steamId, role: "user" } as User,
      send: jest.fn(),
      on: jest.fn(),
    };
    await chat.joinMatchLobby(socket as any, ChatLobbyType.Match, matchId);
    const history = socket.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .find((p: any) => p.event === `lobby:match:${matchId}:messages`);
    return history ? history.data.messages.map((m: any) => m.message) : null;
  }

  async function post(matchId: string, steamId: string, text: string) {
    await join(matchId, steamId);
    const [user] = await postgres.query<Array<User>>(
      "SELECT steam_id::text, name, role FROM players WHERE steam_id = $1",
      [steamId],
    );
    return (
      await chat.sendMessageToChat(ChatLobbyType.Match, matchId, user, text)
    ).accepted;
  }

  it("Hasura reports is_organizer as null, not false, on a matchmaking match", async () => {
    const outsider = await player();
    const matchId = await matchmakingMatch([await player()]);
    const { matches_by_pk } = await hasura.query(
      { matches_by_pk: { __args: { id: matchId }, is_organizer: true } },
      outsider,
    );
    expect(matches_by_pk.is_organizer).toBeNull();
  });

  it.each(["Live", "Finished"])(
    "%s matchmaking match: players read and post, outsiders are refused",
    async (status) => {
      const [p1, p2, outsider] = [
        await player(),
        await player(),
        await player(),
      ];
      const matchId = await matchmakingMatch([p1, p2]);
      await setStatus(matchId, status);

      expect(await post(matchId, p1, "nt")).toBe(true);
      expect(await join(matchId, p2)).toEqual(["nt"]);
      expect(await join(matchId, outsider)).toBeNull();
      expect(await post(matchId, outsider, "hi")).toBe(false);
      expect(await join(matchId, p2)).toEqual(["nt"]);
    },
  );

  it("Captain Pick: the draft's ten players get in before they are seated, nobody else does", async () => {
    const ten: Array<string> = [];
    for (let n = 0; n < 10; n++) ten.push(await player());
    const outsider = await player();
    const matchId = await matchmakingMatch([]);
    expect(
      (
        await postgres.query<Array<{ status: string }>>(
          "SELECT status FROM matches WHERE id = $1",
          [matchId],
        )
      )[0].status,
    ).toBe("PickingPlayers");
    // What CaptainPickService writes once the draft's match shell exists.
    await redis.set(getMatchConfirmationKey(matchId), DRAFT_ID);
    await redis.hset(
      getCaptainPickDraftCacheKey(DRAFT_ID),
      "state",
      JSON.stringify({
        phase: "Drafting",
        matchId,
        participants: ten.map((steam_id) => ({ steam_id })),
      }),
    );

    expect(await post(matchId, ten[0], "glhf")).toBe(true);
    for (const steamId of ten) {
      expect(await join(matchId, steamId)).toEqual(["glhf"]);
    }
    expect(await join(matchId, outsider)).toBeNull();
    expect(await post(matchId, outsider, "hi")).toBe(false);
  });

  it("keeps organizer, administrator and moderator access", async () => {
    const [p1, organizer, admin, moderator, outsider] = [
      await player(),
      await player(),
      await player("administrator"),
      await player("moderator"),
      await player(),
    ];
    const organized = await matchmakingMatch([p1]);
    await postgres.query(
      "UPDATE matches SET organizer_steam_id = $1 WHERE id = $2",
      [organizer, organized],
    );
    await setStatus(organized, "Live");

    expect(await post(organized, p1, "ready")).toBe(true);
    expect(await post(organized, organizer, "go")).toBe(true);
    expect(await join(organized, admin)).toEqual(["ready", "go"]);
    // Moderators read live Match Chat, they don't post in it (a8f76032).
    expect(await join(organized, moderator)).toEqual(["ready", "go"]);
    expect(await post(organized, moderator, "hi")).toBe(false);
    expect(await join(organized, outsider)).toBeNull();
  });
});
