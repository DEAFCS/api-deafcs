import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "../src/postgres/postgres.service";
import { MatchRecoveryController } from "../src/matches/match-recovery/match-recovery.controller";
import { MatchRecoveryService } from "../src/matches/match-recovery/match-recovery.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// Restore Round through the real Hasura metadata (5stackgg/api #665, #667,
// #673): which roles see the recovery actions, that Hasura hands them to the
// API with the caller, and that the API's organizer check (matches.is_organizer
// read as the caller's own role) decides who may restore. The action handler
// is the real MatchRecoveryController and MatchRecoveryService on this
// database; only the game server's RCON reply is stubbed.
describe("match recovery (Hasura actions and permissions)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let hook: http.Server;

  const adminSecret = "match-recovery-hasura-test";
  const rcon: Array<string> = [];
  let rconReply = "";

  let matchId: string;
  let mapId: string;
  const people: Record<string, string> = {};

  const ROLES = [
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];

  const steamId = (accountId: number) =>
    (BigInt(accountId) + 76561197960265728n).toString();

  const backup = (accountId: number, cash: number) => `"SaveFile"
{
	"PlayersOnTeam1"
	{
		"${accountId}"
		{
			"name"		"vexa"
			"cash"		"${cash}"
			"armor"		"100"
			"helmet"		"1"
			"kills"		"2"
			"deaths"		"1"
			"assists"		"0"
			"Items"
			{
				"item"		"weapon_ak47"
			}
		}
	}
}
`;

  async function graphql(
    query: string,
    role: string,
    steamIdHeader: string,
    variables?: Record<string, unknown>,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": role,
        "x-hasura-user-id": steamIdHeader,
      },
      body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<{
      data?: Record<string, any>;
      errors?: Array<{ message: string }>;
    }>;
  }

  async function roleOf(steam: string) {
    const [row] = await postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [steam],
    );
    return row.role;
  }

  // MatchAssistantService.isOrganizer: matches.is_organizer, read through
  // Hasura with the caller's own role (HasuraService.getHasuraHeaders).
  const matchAssistant = {
    isOrganizer: async (id: string, user: { steam_id: string }) => {
      const { data } = await graphql(
        `
          query ($id: uuid!) {
            matches_by_pk(id: $id) {
              is_organizer
            }
          }
        `,
        await roleOf(user.steam_id),
        user.steam_id,
        { id },
      );
      return data!.matches_by_pk.is_organizer;
    },
    requestRoundRestore: async (_id: string, round: number) => {
      rcon.push(`restore_round ${round}`);
      return rconReply;
    },
    restartServerMap: async () => {
      rcon.push("match_state Warmup");
      return rconReply;
    },
    setServerPaused: async (_id: string, paused: boolean) => {
      rcon.push(paused ? "pause" : "resume");
      return rconReply;
    },
    refreshServerMatch: async () => undefined,
  };

  beforeAll(async () => {
    db = await bootContainerAndMigrate("MatchRecoveryHasuraTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199966000000n);

    const controller = new MatchRecoveryController(
      matchAssistant as never,
      new MatchRecoveryService(
        { log: jest.fn(), warn: jest.fn() } as never,
        postgres,
        matchAssistant as never,
      ),
    );

    // What HasuraController.actions does: the caller is the session's player.
    hook = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", async () => {
        const { action, input, session_variables } = JSON.parse(body);
        const steam = session_variables["x-hasura-user-id"];
        try {
          const result = await (controller as any)[action.name]({
            ...input,
            user: { steam_id: steam, role: await roleOf(steam) },
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: (error as Error).message }));
        }
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as AddressInfo).port;

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    // Same engine version as production.
    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: `http://host.docker.internal:${hookPort}`,
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

    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;

    // A live competitive map, rounds 1-3 played, round 3 undone by a restore.
    await fx.region();
    const match = await fx.match({ type: "Duel" });
    matchId = match.id;
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
       SELECT $1, id, 1, 'Live', 'CT', 'TERRORIST' FROM maps ORDER BY name LIMIT 1
       RETURNING id`,
      [matchId],
    );
    mapId = map.id;
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      matchId,
    ]);

    for (const [lineupId, accountId, name] of [
      [match.lineup_1_id, 157864, "vexa"],
      [match.lineup_2_id, 235177, "osk"],
    ] as Array<[string, number, string]>) {
      await postgres.query(
        "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
        [steamId(accountId), name],
      );
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id, is_connected)
         VALUES ($1, $2, true)`,
        [lineupId, steamId(accountId)],
      );
    }
    people.teamPlayer = steamId(157864);

    for (const round of [1, 2, 3]) {
      await postgres.query(
        `INSERT INTO match_map_rounds
           (match_map_id, round, lineup_1_score, lineup_2_score, lineup_1_money, lineup_2_money,
            "time", lineup_1_timeouts_available, lineup_2_timeouts_available,
            lineup_1_side, lineup_2_side, winning_side, backup_file, deleted_at)
         VALUES ($1, $2, $2, 0, 800, 800, now(), 3, 3, 'CT', 'TERRORIST', 'CT', $3, $4)`,
        [
          mapId,
          round,
          backup(157864, 1000 * round),
          round === 3 ? "now()" : null,
        ],
      );
    }

    for (const role of ROLES) {
      people[role] = await fx.player(role);
      await postgres.query("UPDATE players SET role = $2 WHERE steam_id = $1", [
        people[role],
        role,
      ]);
    }
    people.matchOwner = await fx.player("owner");
    await postgres.query(
      "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
      [matchId, people.matchOwner],
    );
    await postgres.query(
      "UPDATE players SET role = 'moderator' WHERE steam_id = $1",
      [people.teamPlayer],
    );
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
    await new Promise((resolve) => hook?.close(resolve));
  });

  beforeEach(() => {
    rcon.length = 0;
    rconReply = "";
  });

  async function fields(role: string) {
    const { data, errors } = await graphql(
      `
        {
          query: __type(name: "query_root") {
            fields {
              name
            }
          }
          mutation: __type(name: "mutation_root") {
            fields {
              name
            }
          }
        }
      `,
      role,
      "0",
    );
    expect(errors).toBeUndefined();
    return [
      ...(data!.query?.fields ?? []),
      ...(data!.mutation?.fields ?? []),
    ].map((field: { name: string }) => field.name);
  }

  const restoreRounds = (steam: string, role: string) =>
    graphql(
      `
        query ($id: uuid!) {
          getMatchRestoreRounds(match_id: $id) {
            restorable
            blocked_reason
            live_round
            economy_hidden
            connected_players
            expected_players
            rounds {
              round
              has_backup
              undone
              lineup_1_score
              players {
                steam_id
                cash
                armor
                helmet
                weapons
                kills
                deaths
                assists
              }
            }
          }
        }
      `,
      role,
      steam,
      { id: matchId },
    );

  const restore = (steam: string, role: string, round: number) =>
    graphql(
      `
        mutation ($id: uuid!, $round: Int!) {
          restoreMatchRound(match_id: $id, round: $round) {
            success
          }
        }
      `,
      role,
      steam,
      { id: matchId, round },
    );

  it("loads consistent metadata", async () => {
    const metadata = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    await expect(metadata.json()).resolves.toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("hides the recovery actions from guests", async () => {
    const names = await fields("guest");
    expect(names).not.toContain("getMatchRestoreRounds");
    expect(names).not.toContain("restoreMatchRound");
    expect(names).not.toContain("restartMatchMap");
    expect(names).not.toContain("setMatchPaused");
  });

  it.each(ROLES)("lets a signed-in %s call them", async (role) => {
    const names = await fields(role);
    expect(names).toEqual(
      expect.arrayContaining([
        "getMatchRestoreRounds",
        "restoreMatchRound",
        "restartMatchMap",
        "setMatchPaused",
      ]),
    );
  });

  it.each([...ROLES, "guest"])(
    "keeps Restart Match switched off for %s",
    async (role) => {
      expect(await fields(role)).not.toContain("restartMatch");
    },
  );

  it.each([
    ["administrator", true],
    ["match_organizer", true],
    ["matchOwner", true],
    // DEAFCS (19dfbbf3): a tournament organizer only organizes its own
    // tournaments' matches; upstream lets the role organize any match.
    ["tournament_organizer", false],
    ["moderator", false],
    ["streamer", false],
    ["verified_user", false],
    ["user", false],
  ])("is_organizer for %s is %s", async (who, expected) => {
    expect(
      await matchAssistant.isOrganizer(matchId, { steam_id: people[who] }),
    ).toBe(expected);
  });

  it("shows an organizer every round with money, armor, weapons and stats", async () => {
    const { data, errors } = await restoreRounds(
      people.administrator,
      "administrator",
    );

    expect(errors).toBeUndefined();
    expect(data!.getMatchRestoreRounds).toMatchObject({
      restorable: true,
      blocked_reason: null,
      live_round: 3,
      economy_hidden: false,
      connected_players: 2,
      expected_players: 2,
    });
    expect(
      data!.getMatchRestoreRounds.rounds.map(
        (round: { round: number; undone: boolean }) => [
          round.round,
          round.undone,
        ],
      ),
    ).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(data!.getMatchRestoreRounds.rounds[1].players).toEqual([
      {
        steam_id: steamId(157864),
        cash: 2000,
        armor: 100,
        helmet: true,
        weapons: ["weapon_ak47"],
        kills: 2,
        deaths: 1,
        assists: 0,
      },
    ]);
  });

  it.each(["match_organizer", "matchOwner"])(
    "lets the %s read the rounds too",
    async (who) => {
      const role = who === "matchOwner" ? "user" : who;
      const { data, errors } = await restoreRounds(people[who], role);
      expect(errors).toBeUndefined();
      expect(data!.getMatchRestoreRounds.rounds).toHaveLength(3);
    },
  );

  it.each(["user", "moderator", "tournament_organizer"])(
    "refuses a %s who doesn't organize the match, without touching the server",
    async (role) => {
      const read = await restoreRounds(people[role], role);
      expect(read.errors?.[0].message).toBe("you are not a match organizer");

      const write = await restore(people[role], role, 2);
      expect(write.errors?.[0].message).toBe("you are not a match organizer");
      expect(rcon).toEqual([]);
    },
  );

  it("hides the economy from an organizer playing in the match, as upstream does", async () => {
    await postgres.query(
      "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
      [matchId, people.teamPlayer],
    );
    try {
      const { data, errors } = await restoreRounds(
        people.teamPlayer,
        "moderator",
      );
      expect(errors).toBeUndefined();
      expect(data!.getMatchRestoreRounds.economy_hidden).toBe(true);
      expect(
        data!.getMatchRestoreRounds.rounds.every(
          (round: { players: Array<unknown> }) => round.players.length === 0,
        ),
      ).toBe(true);
    } finally {
      await postgres.query(
        "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
        [matchId, people.matchOwner],
      );
    }
  });

  const pause = (steam: string, role: string, paused: boolean) =>
    graphql(
      `
        mutation ($id: uuid!, $paused: Boolean!) {
          setMatchPaused(match_id: $id, paused: $paused) {
            success
          }
        }
      `,
      role,
      steam,
      { id: matchId, paused },
    );

  const restartMap = (steam: string, role: string) =>
    graphql(
      `
        mutation ($id: uuid!) {
          restartMatchMap(match_id: $id) {
            success
          }
        }
      `,
      role,
      steam,
      { id: matchId },
    );

  // DEAFCS: an organizer who plays in the match, whatever their role, can't
  // use the recovery or pause controls on it; only an administrator can.
  describe("an organizer playing in the match", () => {
    const asTeamPlayer = async (role: string, run: () => Promise<void>) => {
      await postgres.query("UPDATE players SET role = $2 WHERE steam_id = $1", [
        people.teamPlayer,
        role,
      ]);
      await postgres.query(
        "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
        [matchId, people.teamPlayer],
      );
      try {
        await run();
      } finally {
        await postgres.query(
          "UPDATE matches SET organizer_steam_id = $2 WHERE id = $1",
          [matchId, people.matchOwner],
        );
        await postgres.query(
          "UPDATE players SET role = 'moderator' WHERE steam_id = $1",
          [people.teamPlayer],
        );
      }
    };

    it.each(["moderator", "match_organizer", "tournament_organizer"])(
      "refuses a %s, without touching the server",
      async (role) => {
        await asTeamPlayer(role, async () => {
          const read = await restoreRounds(people.teamPlayer, role);
          expect(read.errors).toBeUndefined();
          expect(read.data!.getMatchRestoreRounds.blocked_reason).toBe(
            "team_member",
          );

          expect(
            (await restore(people.teamPlayer, role, 2)).errors?.[0].message,
          ).toBe(
            "organizers on one of the teams can't restore rounds; players can still call the in-game vote",
          );
          expect(
            (await restartMap(people.teamPlayer, role)).errors?.[0].message,
          ).toBe("organizers on one of the teams can't restart the map");
          expect(
            (await pause(people.teamPlayer, role, true)).errors?.[0].message,
          ).toBe(
            "organizers on one of the teams can't pause or resume the match",
          );
          expect(rcon).toEqual([]);
        });
      },
    );

    it("still lets an administrator", async () => {
      await asTeamPlayer("administrator", async () => {
        const read = await restoreRounds(people.teamPlayer, "administrator");
        expect(read.data!.getMatchRestoreRounds.blocked_reason).toBeNull();

        const { errors } = await pause(
          people.teamPlayer,
          "administrator",
          true,
        );
        expect(errors).toBeUndefined();
        expect(rcon).toEqual(["pause"]);
      });
    });
  });

  describe("pause and resume", () => {
    it.each(["administrator", "match_organizer", "matchOwner"])(
      "lets the %s pause a live map through the game server",
      async (who) => {
        const role = who === "matchOwner" ? "user" : who;
        const { data, errors } = await pause(people[who], role, true);
        expect(errors).toBeUndefined();
        expect(data!.setMatchPaused).toEqual({ success: true });
        expect(rcon).toEqual(["pause"]);
      },
    );

    it.each(["user", "moderator", "tournament_organizer"])(
      "refuses a %s who doesn't organize the match",
      async (role) => {
        const { errors } = await pause(people[role], role, true);
        expect(errors?.[0].message).toBe("you are not a match organizer");
        expect(rcon).toEqual([]);
      },
    );

    it("only resumes a paused map", async () => {
      const live = await pause(
        people.match_organizer,
        "match_organizer",
        false,
      );
      expect(live.errors?.[0].message).toBe("the map isn't paused");

      await postgres.query(
        "UPDATE match_maps SET status = 'Paused' WHERE id = $1",
        [mapId],
      );
      try {
        const paused = await pause(
          people.match_organizer,
          "match_organizer",
          true,
        );
        expect(paused.errors?.[0].message).toBe(
          "there is no live map to pause",
        );

        const { errors } = await pause(
          people.match_organizer,
          "match_organizer",
          false,
        );
        expect(errors).toBeUndefined();
        expect(rcon).toEqual(["resume"]);
      } finally {
        await postgres.query(
          "UPDATE match_maps SET status = 'Live' WHERE id = $1",
          [mapId],
        );
      }
    });
  });

  it("restores a round with a backup through the game server", async () => {
    const { data, errors } = await restore(
      people.administrator,
      "administrator",
      2,
    );

    expect(errors).toBeUndefined();
    expect(data!.restoreMatchRound).toEqual({ success: true });
    expect(rcon).toEqual(["restore_round 2"]);
  });

  it("can go forward again to a round a restore undid", async () => {
    const { errors } = await restore(people.administrator, "administrator", 3);
    expect(errors).toBeUndefined();
    expect(rcon).toEqual(["restore_round 3"]);
  });

  it("refuses a round with no backup before it reaches the server", async () => {
    const { errors } = await restore(people.administrator, "administrator", 7);
    expect(errors?.[0].message).toBe("round 7 has no backup to restore");
    expect(rcon).toEqual([]);
  });

  it("passes on the game server's own refusal", async () => {
    rconReply =
      "restore_round refused: a round restore is already in progress\n";
    const { errors } = await restore(people.administrator, "administrator", 2);
    expect(errors?.[0].message).toBe("a round restore is already in progress");
  });

  it("restarts the map from warmup and keeps its rounds restorable", async () => {
    const { data, errors } = await graphql(
      `
        mutation ($id: uuid!) {
          restartMatchMap(match_id: $id) {
            success
          }
        }
      `,
      "administrator",
      people.administrator,
      { id: matchId },
    );

    expect(errors).toBeUndefined();
    expect(data!.restartMatchMap).toEqual({ success: true });
    expect(rcon).toEqual(["match_state Warmup"]);
    const rows = await postgres.query<
      Array<{ round: number; undone: boolean }>
    >(
      `SELECT round, deleted_at IS NOT NULL AS undone FROM match_map_rounds
        WHERE match_map_id = $1 ORDER BY round`,
      [mapId],
    );
    expect(rows).toEqual([
      { round: 1, undone: true },
      { round: 2, undone: true },
      { round: 3, undone: true },
    ]);
  });

  it("never shows an undone round to players once the map is finished", async () => {
    await postgres.query(
      `UPDATE match_map_rounds SET deleted_at = NULL WHERE match_map_id = $1 AND round < 3`,
      [mapId],
    );
    await fx.finishMap(mapId);

    for (const role of ["guest", "user"]) {
      const { data, errors } = await graphql(
        `
          query ($id: uuid!) {
            match_map_rounds(
              where: { match_map_id: { _eq: $id } }
              order_by: { round: asc }
            ) {
              round
            }
          }
        `,
        role,
        role === "guest" ? "0" : people.user,
        { id: mapId },
      );
      expect(errors).toBeUndefined();
      expect(data!.match_map_rounds).toEqual([{ round: 1 }, { round: 2 }]);
    }
  });
});
