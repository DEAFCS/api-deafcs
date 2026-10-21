import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createClient } from "../generated";
import { PostgresService } from "../src/postgres/postgres.service";
import { MatchEventsGateway } from "../src/matches/match-events.gateway";
import UtilityEvent from "../src/matches/events/UtilityEvent";
import KillEvent from "../src/matches/events/KillEvent";
import FlashEvent from "../src/matches/events/FlashEvent";
import AssistEvent from "../src/matches/events/AssistEvent";
import ObjectiveEvent from "../src/matches/events/ObjectiveEvent";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// A game server redelivers an event until the API acks its messageId. When the
// ack is lost (the API restarted mid-match), the server keeps resending an
// event whose row is already stored, after the gateway's 10s dedup entry is
// gone. The stat tables are TimescaleDB hypertables keyed on the event itself,
// so the replay used to fail on the primary key every time and was never acked
// (production 2026-10-21, "88_player_utility_pkey"). Real TimescaleDB and the
// production Hasura engine, so ON CONFLICT ON CONSTRAINT runs on a hypertable.
describe("match event replays (TimescaleDB + Hasura)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasuraContainer: StartedTestContainer;
  let hasura: { mutation: (request: any) => Promise<any> };

  const adminSecret = "match-events-replay-test";
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  let matchId: string;
  let mapId: string;
  let attacker: string;
  let victim: string;

  // What HasuraService.mutation does with the admin secret.
  const makeHasura = (endpoint: string) => ({
    mutation: async (request: any) => {
      try {
        return await createClient({
          url: `${endpoint}/v1/graphql`,
          headers: {
            "Content-Type": "application/json",
            "x-hasura-admin-secret": adminSecret,
          },
        }).mutation(request);
      } catch (error) {
        if ((error as any)?.response) {
          throw (error as any).response.errors.at(0).message;
        }
        throw error;
      }
    },
  });

  const processor = <T>(
    Processor: new (...args: any[]) => {
      setData(matchId: string, data: T): void;
      process(): Promise<void>;
    },
    data: T,
  ) => {
    const instance = new Processor(
      logger,
      hasura,
      {},
      {},
      {},
      postgres,
      {},
    );
    instance.setData(matchId, data);
    return instance;
  };

  const count = async (table: string) => {
    const [row] = await postgres.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM ${table} WHERE match_map_id = $1`,
      [mapId],
    );
    return row.n;
  };

  const utility = (time: string) => ({
    time,
    round: 3,
    attacker_steam_id: attacker,
    location: "BombsiteA",
    type: "Smoke",
    match_map_id: mapId,
    attacker_location_coordinates: "100 200 300",
  });

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MatchEventsReplayTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199967000000n);

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    // Same engine version as production.
    hasuraContainer = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("./hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();

    hasura = makeHasura(
      `http://${hasuraContainer.getHost()}:${hasuraContainer.getMappedPort(8080)}`,
    );

    await fx.region();
    ({ matchId, mapId } = await fx.bareMatch());
    attacker = await fx.player("attacker");
    victim = await fx.player("victim");
  }, 600_000);

  afterAll(async () => {
    await hasuraContainer?.stop();
    await db?.stop();
  });

  it("the player stat tables are hypertables", async () => {
    const rows = await postgres.query<Array<{ hypertable_name: string }>>(
      `SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_name IN ('player_utility', 'player_kills',
              'player_flashes', 'player_assists', 'player_objectives')
        ORDER BY 1`,
    );
    expect(rows.map((row) => row.hypertable_name)).toEqual([
      "player_assists",
      "player_flashes",
      "player_kills",
      "player_objectives",
      "player_utility",
    ]);
  });

  it("without on_conflict a replayed utility event fails on the primary key (the production error)", async () => {
    const time = "2026-10-21T17:00:00.123Z";
    await processor(UtilityEvent, utility(time)).process();

    await expect(
      hasura.mutation({
        insert_player_utility_one: {
          __args: {
            object: {
              time: new Date(time),
              match_id: matchId,
              match_map_id: mapId,
              round: 3,
              type: "Smoke",
              attacker_steam_id: attacker,
              attacker_location_coordinates: "100 200 300",
            },
          },
          __typename: true,
        },
      }),
    ).rejects.toThrow(/Uniqueness violation.*player_utility_pkey/);
  });

  it("a replayed utility event is accepted and stored once", async () => {
    const before = await count("player_utility");
    const time = "2026-10-21T17:01:00.456Z";

    await processor(UtilityEvent, utility(time)).process();
    await processor(UtilityEvent, utility(time)).process();
    await processor(UtilityEvent, utility(time)).process();

    expect(await count("player_utility")).toBe(before + 1);
  });

  it("keeps every distinct utility event, including two in a row from one player", async () => {
    const before = await count("player_utility");

    await processor(UtilityEvent, utility("2026-10-21T17:02:00.001Z")).process();
    await processor(UtilityEvent, utility("2026-10-21T17:02:00.002Z")).process();
    await processor(UtilityEvent, {
      ...utility("2026-10-21T17:02:00.001Z"),
      attacker_steam_id: victim,
    }).process();

    expect(await count("player_utility")).toBe(before + 3);
  });

  it("the replay keeps the stored row as it was", async () => {
    const time = "2026-10-21T17:03:00.000Z";
    await processor(UtilityEvent, utility(time)).process();
    await processor(UtilityEvent, {
      ...utility(time),
      type: "Flash",
      round: 9,
    }).process();

    const [row] = await postgres.query<Array<{ type: string; round: number }>>(
      `SELECT type, round FROM player_utility
        WHERE match_map_id = $1 AND attacker_steam_id = $2 AND time = $3`,
      [mapId, attacker, time],
    );
    expect(row).toEqual({ type: "Smoke", round: 3 });
  });

  it("a replayed kill is stored once and counted once in player_stats", async () => {
    const kill = {
      time: "2026-10-21T17:04:00.000Z",
      round: 4,
      attacker_steam_id: attacker,
      attacker_team: "TERRORIST",
      attacker_location: "Long",
      attacker_location_coordinates: "1 2 3",
      weapon: "ak47",
      hitgroup: "head",
      attacked_steam_id: victim,
      attacked_team: "CT",
      attacked_location: "Long",
      attacked_location_coordinates: "4 5 6",
      match_map_id: mapId,
      no_scope: false,
      blinded: false,
      thru_smoke: false,
      thru_wall: false,
      headshot: true,
      assisted: false,
      in_air: false,
    };
    const stats = async () => {
      const [row] = await postgres.query<
        Array<{ kills: number; headshots: number }>
      >(
        "SELECT kills::int, headshots::int FROM player_stats WHERE player_steam_id = $1",
        [attacker],
      );
      return row ?? { kills: 0, headshots: 0 };
    };
    const deaths = async () => {
      const [row] = await postgres.query<Array<{ deaths: number }>>(
        "SELECT deaths::int FROM player_stats WHERE player_steam_id = $1",
        [victim],
      );
      return row?.deaths ?? 0;
    };

    const kills = await count("player_kills");
    const before = await stats();
    const deathsBefore = await deaths();

    await processor(KillEvent, kill).process();
    await processor(KillEvent, kill).process();

    expect(await count("player_kills")).toBe(kills + 1);
    expect(await stats()).toEqual({
      kills: before.kills + 1,
      headshots: before.headshots + 1,
    });
    expect(await deaths()).toBe(deathsBefore + 1);
  });

  it("replayed flash, assist and objective events are stored once", async () => {
    const flash = {
      time: "2026-10-21T17:05:00.000Z",
      round: 5,
      attacker_steam_id: attacker,
      attacked_steam_id: victim,
      match_map_id: mapId,
      duration: 2.5,
      team_flash: false,
    };
    const assist = {
      time: "2026-10-21T17:05:01.000Z",
      round: 5,
      attacker_steam_id: attacker,
      attacker_team: "TERRORIST",
      attacker_location: "Long",
      attacked_steam_id: victim,
      attacked_team: "CT",
      flash: true,
      match_map_id: mapId,
    };
    const objective = {
      time: "2026-10-21T17:05:02.000Z",
      round: 5,
      player_steam_id: attacker,
      type: "Planted",
      match_map_id: mapId,
    };

    const before = {
      flashes: await count("player_flashes"),
      assists: await count("player_assists"),
      objectives: await count("player_objectives"),
    };

    for (let i = 0; i < 2; i++) {
      await processor(FlashEvent, flash).process();
      await processor(AssistEvent, assist).process();
      await processor(ObjectiveEvent, objective).process();
    }

    expect({
      flashes: await count("player_flashes"),
      assists: await count("player_assists"),
      objectives: await count("player_objectives"),
    }).toEqual({
      flashes: before.flashes + 1,
      assists: before.assists + 1,
      objectives: before.objectives + 1,
    });
  });

  it("the gateway acks a redelivery that arrives after its dedup entry expired", async () => {
    const time = "2026-10-21T17:06:00.000Z";
    const cache = {
      // The 10s entry is gone by the time the server resends.
      has: jest.fn().mockResolvedValue(false),
      put: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = {
      resolve: jest.fn(async (Processor: any) =>
        processor(Processor, undefined),
      ),
    };
    const gateway = new MatchEventsGateway(
      logger as never,
      moduleRef as never,
      {} as never,
      cache as never,
    );
    const message = {
      matchId,
      mapId,
      messageId: "92fb4a94-dc73-464f-9919-1e55b973e63e",
      data: { event: "utility", data: utility(time) },
    };
    logger.error.mockClear();

    await expect(gateway.handleMatchEvent(message)).resolves.toBe(
      message.messageId,
    );
    await expect(gateway.handleMatchEvent(message)).resolves.toBe(
      message.messageId,
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalledTimes(2);
    const [row] = await postgres.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM player_utility
        WHERE match_map_id = $1 AND time = $2`,
      [mapId, time],
    );
    expect(row.n).toBe(1);
  });
});
