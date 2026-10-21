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

  // DEAFCS: match organizers, tournament organizers and administrators keep
  // the recovery and pause controls on a match they play in, but never get
  // the economy there. Below match_organizer, a player who organizes their
  // own match is refused as upstream does.
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

    it.each(["match_organizer", "tournament_organizer", "administrator"])(
      "lets a %s restore and pause, with scores but no economy",
      async (role) => {
        await asTeamPlayer(role, async () => {
          const read = await restoreRounds(people.teamPlayer, role);
          expect(read.errors).toBeUndefined();
          expect(read.data!.getMatchRestoreRounds).toMatchObject({
            blocked_reason: null,
            restorable: true,
            economy_hidden: true,
          });
          const rounds = read.data!.getMatchRestoreRounds.rounds;
          expect(
            rounds.map((round: { round: number; lineup_1_score: number }) => [
              round.round,
              round.lineup_1_score,
            ]),
          ).toEqual([
            [1, 1],
            [2, 2],
            [3, 3],
          ]);
          expect(
            rounds.every(
              (round: { players: Array<unknown> }) =>
                round.players.length === 0,
            ),
          ).toBe(true);

          expect((await restore(people.teamPlayer, role, 2)).errors).toBe(
            undefined,
          );
          expect((await pause(people.teamPlayer, role, true)).errors).toBe(
            undefined,
          );
          expect(rcon).toEqual(["restore_round 2", "pause"]);
        });
      },
    );

    it("lets a match_organizer restart the map", async () => {
      await asTeamPlayer("match_organizer", async () => {
        try {
          const { errors } = await restartMap(
            people.teamPlayer,
            "match_organizer",
          );
          expect(errors).toBeUndefined();
          expect(rcon).toEqual(["match_state Warmup"]);
        } finally {
          await postgres.query(
            `UPDATE match_map_rounds SET deleted_at = NULL
              WHERE match_map_id = $1 AND round < 3`,
            [mapId],
          );
        }
      });
    });

    it("still refuses a moderator who organizes and plays in it", async () => {
      await asTeamPlayer("moderator", async () => {
        const read = await restoreRounds(people.teamPlayer, "moderator");
        expect(read.data!.getMatchRestoreRounds.blocked_reason).toBe(
          "team_member",
        );
        expect(
          (await restore(people.teamPlayer, "moderator", 2)).errors?.[0]
            .message,
        ).toBe(
          "organizers on one of the teams can't restore rounds; players can still call the in-game vote",
        );
        expect(
          (await pause(people.teamPlayer, "moderator", true)).errors?.[0]
            .message,
        ).toBe(
          "organizers on one of the teams can't pause or resume the match",
        );
        expect(rcon).toEqual([]);
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

  const organizerControls = (steam: string, role: string, id = matchId) =>
    graphql(
      `
        query ($id: uuid!) {
          matches_by_pk(id: $id) {
            is_organizer
            can_cancel
            can_assign_server
          }
        }
      `,
      role,
      steam,
      { id },
    );

  // User A: the global match_organizer role on a match they neither created
  // nor play in. User B: the match's creator (matchOwner, a plain user).
  describe("User A, a match_organizer on someone else's match", () => {
    it("is neither the creator nor a player", async () => {
      const [row] = await postgres.query<
        Array<{ creator: string; plays: boolean }>
      >(
        `SELECT m.organizer_steam_id::text AS creator,
                EXISTS (SELECT 1 FROM match_lineup_players mlp
                         WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                           AND mlp.steam_id = $2) AS plays
           FROM matches m WHERE m.id = $1`,
        [matchId, people.match_organizer],
      );
      expect(row).toEqual({ creator: people.matchOwner, plays: false });
      expect(await roleOf(people.match_organizer)).toBe("match_organizer");
      expect(await roleOf(people.matchOwner)).toBe("user");
    });

    it("gets the same organizer controls as User B, the creator", async () => {
      const a = await organizerControls(
        people.match_organizer,
        "match_organizer",
      );
      const b = await organizerControls(people.matchOwner, "user");
      expect(a.errors).toBeUndefined();
      expect(b.errors).toBeUndefined();
      expect(a.data!.matches_by_pk).toEqual({
        is_organizer: true,
        can_cancel: true,
        can_assign_server: true,
      });
      expect(a.data!.matches_by_pk).toEqual(b.data!.matches_by_pk);

      const outsider = await organizerControls(
        people.tournament_organizer,
        "tournament_organizer",
      );
      expect(outsider.data!.matches_by_pk).toEqual({
        is_organizer: false,
        can_cancel: false,
        can_assign_server: false,
      });
    });

    it("opens the Rounds tab with scores but no economy", async () => {
      const { data, errors } = await restoreRounds(
        people.match_organizer,
        "match_organizer",
      );
      expect(errors).toBeUndefined();
      expect(data!.getMatchRestoreRounds).toMatchObject({
        restorable: true,
        blocked_reason: null,
        economy_hidden: true,
      });
      expect(data!.getMatchRestoreRounds.rounds).toHaveLength(3);
      expect(
        data!.getMatchRestoreRounds.rounds.every(
          (round: { players: Array<unknown> }) => round.players.length === 0,
        ),
      ).toBe(true);
    });

    it("restores a round", async () => {
      const { data, errors } = await restore(
        people.match_organizer,
        "match_organizer",
        2,
      );
      expect(errors).toBeUndefined();
      expect(data!.restoreMatchRound).toEqual({ success: true });
      expect(rcon).toEqual(["restore_round 2"]);
    });

    it("pauses and resumes", async () => {
      expect(
        (await pause(people.match_organizer, "match_organizer", true)).errors,
      ).toBeUndefined();
      await postgres.query(
        "UPDATE match_maps SET status = 'Paused' WHERE id = $1",
        [mapId],
      );
      try {
        expect(
          (await pause(people.match_organizer, "match_organizer", false))
            .errors,
        ).toBeUndefined();
      } finally {
        await postgres.query(
          "UPDATE match_maps SET status = 'Live' WHERE id = $1",
          [mapId],
        );
      }
      expect(rcon).toEqual(["pause", "resume"]);
    });

    it("gets no admin-only server action, RCON password or Restart Match", async () => {
      const names = await fields("match_organizer");
      for (const adminOnly of [
        "restartMatch",
        "restartService",
        "readServerFile",
      ]) {
        expect(names).not.toContain(adminOnly);
      }

      const { errors } = await graphql(
        `
          {
            servers {
              rcon_password
            }
          }
        `,
        "match_organizer",
        people.match_organizer,
      );
      expect(errors?.[0].message).toMatch(/rcon_password/);
    });

    it("restarts the map", async () => {
      const { data, errors } = await restartMap(
        people.match_organizer,
        "match_organizer",
      );
      expect(errors).toBeUndefined();
      expect(data!.restartMatchMap).toEqual({ success: true });
      expect(rcon).toEqual(["match_state Warmup"]);
    });
  });

  // DEAFCS (19dfbbf3): a tournament_organizer organizes only its own
  // tournaments' matches (as owner or co-organizer).
  describe("a tournament_organizer", () => {
    let tournamentMatchId: string;
    let tournamentLineupId: string;
    let coOrganizer: string;

    beforeAll(async () => {
      const match = await fx.match({ type: "Duel" });
      tournamentMatchId = match.id;
      tournamentLineupId = match.lineup_1_id;
      await postgres.query(
        `INSERT INTO match_maps (match_id, map_id, "order", status, lineup_1_side, lineup_2_side)
         SELECT $1, id, 1, 'Live', 'CT', 'TERRORIST' FROM maps ORDER BY name LIMIT 1`,
        [tournamentMatchId],
      );
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        tournamentMatchId,
      ]);

      const [tournament] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
         VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
        [fx.nextName("cup"), people.tournament_organizer, match.options_id],
      );
      const [stage] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
         VALUES ($1, 'SingleElimination', 1, 4, 8) RETURNING id`,
        [tournament.id],
      );
      await postgres.query(
        `INSERT INTO tournament_brackets (tournament_stage_id, match_id, round)
         VALUES ($1, $2, 1)`,
        [stage.id, tournamentMatchId],
      );

      coOrganizer = await fx.player("co-organizer");
      await postgres.query(
        "UPDATE players SET role = 'tournament_organizer' WHERE steam_id = $1",
        [coOrganizer],
      );
      await postgres.query(
        "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
        [tournament.id, coOrganizer],
      );
    });

    const pauseMatch = (steam: string, role: string, id: string) =>
      graphql(
        `
          mutation ($id: uuid!) {
            setMatchPaused(match_id: $id, paused: true) {
              success
            }
          }
        `,
        role,
        steam,
        { id },
      );

    it("organizes its own tournament's match, and only that one", async () => {
      for (const steam of [people.tournament_organizer, coOrganizer]) {
        const own = await organizerControls(
          steam,
          "tournament_organizer",
          tournamentMatchId,
        );
        expect(own.data!.matches_by_pk.is_organizer).toBe(true);

        const other = await organizerControls(steam, "tournament_organizer");
        expect(other.data!.matches_by_pk.is_organizer).toBe(false);
      }

      // The global match_organizer role covers tournament matches too.
      const matchOrganizer = await organizerControls(
        people.match_organizer,
        "match_organizer",
        tournamentMatchId,
      );
      expect(matchOrganizer.data!.matches_by_pk.is_organizer).toBe(true);
    });

    it("pauses its own tournament's match but not another match", async () => {
      const own = await pauseMatch(
        people.tournament_organizer,
        "tournament_organizer",
        tournamentMatchId,
      );
      expect(own.errors).toBeUndefined();
      expect(rcon).toEqual(["pause"]);

      rcon.length = 0;
      const other = await pauseMatch(
        people.tournament_organizer,
        "tournament_organizer",
        matchId,
      );
      expect(other.errors?.[0].message).toBe("you are not a match organizer");
      expect(rcon).toEqual([]);
    });

    it("keeps the controls while playing in its own tournament's match", async () => {
      await postgres.query(
        `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
        [tournamentLineupId, people.tournament_organizer],
      );
      try {
        const { errors } = await pauseMatch(
          people.tournament_organizer,
          "tournament_organizer",
          tournamentMatchId,
        );
        expect(errors).toBeUndefined();
        expect(rcon).toEqual(["pause"]);
      } finally {
        await postgres.query(
          "DELETE FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2",
          [tournamentLineupId, people.tournament_organizer],
        );
      }
    });
  });

  // DEAFCS: rebooting a match server is administrator-only.
  it.each(ROLES)(
    "offers rebootMatchServer only to administrators (%s)",
    async (role) => {
      expect((await fields(role)).includes("rebootMatchServer")).toBe(
        role === "administrator",
      );
    },
  );

  // DEAFCS: a server's real address (host, port, GOTV port) only for
  // administrators; public servers keep their join links.
  describe("server addresses", () => {
    let publicServerId: string;

    beforeAll(async () => {
      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers (host, label, rcon_password, port, tv_port, enabled, connected, region, type, is_dedicated)
         VALUES ('203.0.113.7', 'public-casual', '\\x00'::bytea, 27016, 27021, true, true, 'TestA', 'Casual', true)
         RETURNING id`,
      );
      publicServerId = server.id;
    });

    const server = (role: string, columns: string) =>
      graphql(
        `
          query ($id: uuid!) {
            servers_by_pk(id: $id) {
              ${columns}
            }
          }
        `,
        role,
        role === "guest" ? "0" : people[role],
        { id: publicServerId },
      );

    it.each(["guest", ...ROLES.filter((role) => role !== "administrator")])(
      "hides host, port and tv_port from %s but keeps the join link",
      async (role) => {
        for (const column of ["host", "port", "tv_port"]) {
          const { errors } = await server(role, `id ${column}`);
          expect(errors?.[0].message).toMatch(new RegExp(column));
        }

        const { data, errors } = await server(
          role,
          "id label connection_link connection_string",
        );
        expect(errors).toBeUndefined();
        expect(data!.servers_by_pk).toMatchObject({
          label: "public-casual",
          connection_link: expect.stringContaining("+connect "),
          connection_string: expect.stringContaining("connect "),
        });
      },
    );

    it("still shows administrators the address", async () => {
      const { data, errors } = await server(
        "administrator",
        "host port tv_port",
      );
      expect(errors).toBeUndefined();
      expect(data!.servers_by_pk).toEqual({
        host: "203.0.113.7",
        port: 27016,
        tv_port: 27021,
      });
    });
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
