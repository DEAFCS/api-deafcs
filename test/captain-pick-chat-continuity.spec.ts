import path from "path";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createClient } from "../generated";
import { ChatService } from "../src/chat/chat.service";
import { ChatLobbyType } from "../src/chat/enums/ChatLobbyTypes";
import { User } from "../src/auth/types/User";
import { CaptainPickService } from "../src/matchmaking/captain-pick/captain-pick.service";
import { getCaptainPickTeamChatId } from "../src/matchmaking/captain-pick/captain-pick-team-chat";
import { getPickingLineup } from "../src/matchmaking/captain-pick/captain-pick-rules";
import { MatchAssistantService } from "../src/matches/match-assistant/match-assistant.service";
import { getMatchmakingConformationCacheKey } from "../src/matchmaking/utilities/cacheKeys";
import { PostgresService } from "../src/postgres/postgres.service";
import { FakeQueue } from "./mocks/fake-redis";
import { Fixtures } from "./utils/fixtures";
import {
  bootContainerAndMigrate,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// 5v5 Captain Pick from the first pick to a live match, through the real
// CaptainPickService and ChatService: Postgres with every DEAFCS trigger and
// function, the real Hasura engine with this repo's metadata (so access is
// decided by the same permission/computed fields production uses) and a real
// Redis. Match Chat must be one conversation the whole way through, open to
// exactly the ten players; each Team Chat stays with its own team.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";
const REDIS_IMAGE = "redis:7.4-alpine";
const REGION = "TestA";
const CONFIRMATION_ID = "77777777-7777-4777-8777-777777777777";

describe("Captain Pick Match Chat continuity (Postgres, Hasura, Redis)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasuraContainer: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let redis: Redis;
  let endpoint: string;
  const adminSecret = "captain-pick-chat-local-test";

  // HasuraService.query/mutation: admin, or the player's own role and id.
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
    db = await bootContainerAndMigrate("CaptainPickChatContinuity");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199982000000n);
    await seedRegionWithServer(postgres, REGION);

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
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await redisContainer?.stop();
    await hasuraContainer?.stop();
    await db?.stop();
  });

  let ten: Array<string>;
  let outsider: string;
  let chat: ChatService;
  let captainPick: CaptainPickService;
  const matchAssistant = {
    createMatchBasedOnType: (...args: any[]) =>
      (MatchAssistantService.prototype.createMatchBasedOnType as any).apply(
        { hasura },
        args,
      ),
    updateMatchStatus: (...args: any[]) =>
      (MatchAssistantService.prototype.updateMatchStatus as any).apply(
        { hasura },
        args,
      ),
  };

  beforeEach(async () => {
    await redis.flushall();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");

    ten = [];
    for (let n = 0; n < 10; n++) ten.push(await fx.player());
    outsider = await fx.player();

    chat = new ChatService(
      new Logger("CaptainPickChatContinuity"),
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
    // No sockets here: broadcasts and unread fan-out are not under test.
    jest.spyOn(chat, "to").mockResolvedValue(undefined);
    jest.spyOn(chat as any, "notifyLobbyMembers").mockResolvedValue(undefined);

    captainPick = new CaptainPickService(
      new Logger("CaptainPickChatContinuity"),
      hasura as any,
      { getConnection: () => redis } as any,
      matchAssistant as any,
      { getSettings: async () => ({ enabled: true, pickSeconds: 30 }) } as any,
      new FakeQueue() as any,
      chat,
    );

    // The Competitive confirmation matchmaking hands to Captain Pick.
    await redis.hset(getMatchmakingConformationCacheKey(CONFIRMATION_ID), {
      type: "Competitive",
      variant: "CaptainPick",
      region: REGION,
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      lobbyIds: JSON.stringify(ten),
      participants: JSON.stringify(
        ten.map((steam_id, n) => ({
          steam_id,
          lobbyId: steam_id,
          joinedAt: new Date(Date.now() - (20 - n) * 1000).toISOString(),
        })),
      ),
      team1: "[]",
      team2: "[]",
    });
  });

  const state = () => captainPick.getState(CONFIRMATION_ID) as Promise<any>;
  const status = async (matchId: string) =>
    (
      await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [matchId],
      )
    )[0].status;

  const client = (steamId: string) => ({
    id: `client-${steamId}`,
    user: { steam_id: steamId, name: steamId, role: "user" } as User,
    send: jest.fn(),
    on: jest.fn(),
  });

  // Joins a room the way the socket does; returns the history it was sent,
  // or null when the server refused the join.
  async function join(type: ChatLobbyType, id: string, steamId: string) {
    const socket = client(steamId);
    await chat.joinMatchLobby(socket as any, type, id);
    const history = socket.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .find((p: any) => p.event === `lobby:${type}:${id}:messages`);
    return history ? history.data.messages.map((m: any) => m.message) : null;
  }

  // Posts like a client does: join the room, then send.
  async function post(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    text: string,
  ) {
    await join(type, id, steamId);
    const [player] = await postgres.query<Array<User>>(
      "SELECT steam_id::text, name, role FROM players WHERE steam_id = $1",
      [steamId],
    );
    return (await chat.sendMessageToChat(type, id, player, text)).accepted;
  }

  // Captains pick until the teams lock, then the server creates the match.
  async function pickTeams() {
    for (let i = 0; i < 7; i++) {
      const s = await state();
      const lineup = getPickingLineup(s.draft.pickIndex) as 1 | 2;
      await captainPick.pick(
        CONFIRMATION_ID,
        s.draft.captains[lineup].steam_id,
        s.draft.available[0].steam_id,
        s.draft.pickIndex,
      );
    }
  }

  // Each team's captain bans in turn, as themselves, until the map is set.
  async function vetoMaps(matchId: string) {
    for (let guard = 0; guard < 20; guard++) {
      const { matches_by_pk: match } = await hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          status: true,
          map_veto_picking_lineup_id: true,
          map_veto_type: true,
          lineup_1_id: true,
          lineup_1: { captain: { steam_id: true } },
          lineup_2: { captain: { steam_id: true } },
          options: { map_pool: { maps: { id: true } } },
          map_veto_picks: { map_id: true },
        },
      });
      if (match.status !== "Veto" || !match.map_veto_picking_lineup_id) return;
      const taken = new Set(match.map_veto_picks.map((p: any) => p.map_id));
      const map = match.options.map_pool.maps.find(
        (m: any) => !taken.has(m.id),
      );
      const captain =
        match.map_veto_picking_lineup_id === match.lineup_1_id
          ? match.lineup_1.captain.steam_id
          : match.lineup_2.captain.steam_id;
      await hasura.mutation(
        {
          insert_match_map_veto_picks_one: {
            __args: {
              object: {
                match_id: matchId,
                match_lineup_id: match.map_veto_picking_lineup_id,
                map_id: map.id,
                type: match.map_veto_type,
              },
            },
            id: true,
          },
        },
        String(captain),
      );
    }
    throw new Error("map veto did not finish");
  }

  it("keeps one Match Chat, open to exactly the ten players, from the first pick to a live match", async () => {
    // 1. The draft starts; the match exists under its fixed id from now on.
    await captainPick.startDraft(CONFIRMATION_ID);
    expect(await captainPick.ensureMatchShell(CONFIRMATION_ID)).toBe(true);
    const matchId = (await state()).matchId as string;
    expect(await status(matchId)).toBe("PickingPlayers");

    for (const steamId of ten) {
      expect(await join(ChatLobbyType.Match, matchId, steamId)).toEqual([]);
    }
    expect(await join(ChatLobbyType.Match, matchId, outsider)).toBeNull();
    expect(await post(ChatLobbyType.Match, matchId, ten[0], "glhf")).toBe(true);
    expect(await post(ChatLobbyType.Match, matchId, outsider, "hi")).toBe(
      false,
    );

    // 2. Captains pick; the match is created and both lineups are seated.
    await pickTeams();
    expect(await post(ChatLobbyType.Match, matchId, ten[9], "picks done")).toBe(
      true,
    );
    await captainPick.finalize(CONFIRMATION_ID);
    expect((await state()).phase).toBe("MatchCreated");
    expect((await state()).matchId).toBe(matchId);
    expect(await status(matchId)).toBe("Veto");

    // 3. Map veto by the two captains, as themselves.
    await vetoMaps(matchId);
    expect(await status(matchId)).not.toBe("Veto");
    const maps = await postgres.query<Array<{ count: number }>>(
      "SELECT COUNT(*)::int AS count FROM match_maps WHERE match_id = $1",
      [matchId],
    );
    expect(maps[0].count).toBe(1);
    expect(await post(ChatLobbyType.Match, matchId, ten[4], "map set")).toBe(
      true,
    );

    // 4. Warmup / live.
    await matchAssistant.updateMatchStatus(matchId, "Live");
    expect(await status(matchId)).toBe("Live");

    // 5. Same room, whole history, every player can read and post.
    const history = ["glhf", "picks done", "map set"];
    for (const steamId of ten) {
      expect(await join(ChatLobbyType.Match, matchId, steamId)).toEqual(
        history,
      );
    }
    expect(await post(ChatLobbyType.Match, matchId, ten[7], "gg")).toBe(true);
    expect(await join(ChatLobbyType.Match, matchId, ten[2])).toEqual([
      ...history,
      "gg",
    ]);

    // Nobody else, at any stage.
    expect(await join(ChatLobbyType.Match, matchId, outsider)).toBeNull();
    expect(await post(ChatLobbyType.Match, matchId, outsider, "hi")).toBe(
      false,
    );
  });

  it("keeps each Team Chat with its own team across the same stages", async () => {
    await captainPick.startDraft(CONFIRMATION_ID);
    await captainPick.ensureMatchShell(CONFIRMATION_ID);
    await pickTeams();
    const s = await state();
    const matchId = s.matchId as string;
    const sideOf = (lineup: 1 | 2) => s.draft.lineups[lineup] as Array<string>;

    const roomA = getCaptainPickTeamChatId(CONFIRMATION_ID, 1);
    const roomB = getCaptainPickTeamChatId(CONFIRMATION_ID, 2);
    expect(
      await post(ChatLobbyType.CaptainPickTeam, roomA, sideOf(1)[1], "A plan"),
    ).toBe(true);
    expect(
      await post(ChatLobbyType.CaptainPickTeam, roomB, sideOf(2)[1], "B plan"),
    ).toBe(true);
    expect(
      await post(ChatLobbyType.CaptainPickTeam, roomB, sideOf(1)[0], "spy"),
    ).toBe(false);

    await captainPick.finalize(CONFIRMATION_ID);
    await vetoMaps(matchId);
    await matchAssistant.updateMatchStatus(matchId, "Live");

    const [match] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    const teamA = `${matchId}:${match.lineup_1_id}`;
    const teamB = `${matchId}:${match.lineup_2_id}`;

    for (const steamId of sideOf(1)) {
      expect(await join(ChatLobbyType.MatchTeam, teamA, steamId)).toEqual([
        "A plan",
      ]);
      expect(await join(ChatLobbyType.MatchTeam, teamB, steamId)).toBeNull();
    }
    for (const steamId of sideOf(2)) {
      expect(await join(ChatLobbyType.MatchTeam, teamB, steamId)).toEqual([
        "B plan",
      ]);
      expect(await join(ChatLobbyType.MatchTeam, teamA, steamId)).toBeNull();
    }
    expect(await join(ChatLobbyType.MatchTeam, teamA, outsider)).toBeNull();
    expect(
      await post(ChatLobbyType.MatchTeam, teamB, sideOf(1)[0], "spy"),
    ).toBe(false);
    expect(
      await post(ChatLobbyType.MatchTeam, teamA, sideOf(1)[2], "push A"),
    ).toBe(true);
    expect(await join(ChatLobbyType.MatchTeam, teamA, sideOf(1)[3])).toEqual([
      "A plan",
      "push A",
    ]);
  });
});
