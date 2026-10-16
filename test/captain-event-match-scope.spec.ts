import path from "path";
import { Logger } from "@nestjs/common";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { createClient } from "../generated";
import CaptainEvent from "../src/matches/events/CaptainEvent";
import { MatchAssistantService } from "../src/matches/match-assistant/match-assistant.service";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootContainerAndMigrate,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A game server reports a captain claim or release for one match. Only that
// match's lineups may change: the event used to match on steam_id alone, so a
// captain disconnecting in warmup released their captaincy in every lineup
// they had ever played, and pick_captain then handed each of those lineups to
// its lowest steam id (DEAFCS 5v5 Random Beta #3, Team 3, 2026-10-16).
//
// The real CaptainEvent runs against the real Hasura engine with this repo's
// metadata, and the real lineup triggers (tau_match_lineup_players,
// pick_captain) run underneath it.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";

describe("captain events stay inside their own match (Hasura)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let hasuraContainer: StartedTestContainer;
  let hasura: { query: any; mutation: any };
  let updatedRows: Array<number>;
  const adminSecret = "captain-event-local-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("CaptainEventMatchScope");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199981000000n);
    await seedRegionWithServer(postgres, "TestA");

    const c = db.container!;
    const databaseUrl = `postgres://${c.getUsername()}:${c.getPassword()}@host.docker.internal:${c.getPort()}/${c.getDatabase()}`;
    hasuraContainer = await new GenericContainer(HASURA_IMAGE)
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
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

    // The API talks to Hasura as admin through the same genql client.
    const client = createClient({
      url: `http://${hasuraContainer.getHost()}:${hasuraContainer.getMappedPort(8080)}/v1/graphql`,
      headers: { "x-hasura-admin-secret": adminSecret },
    });
    hasura = {
      query: (request: any) => client.query(request),
      mutation: async (request: any) => {
        const result = await client.mutation(request);
        updatedRows.push(result.update_match_lineup_players?.affected_rows);
        return result;
      },
    };
  }, 600_000);

  afterAll(async () => {
    await hasuraContainer?.stop();
    await db?.stop();
  });

  async function captainEvent(
    matchId: string,
    data: { claim: boolean; steam_id: string; player_name: string },
  ) {
    const logger = new Logger("CaptainEventMatchScope");
    const matchAssistant = {
      getMatchLineups: (id: string) =>
        MatchAssistantService.prototype.getMatchLineups.call({ hasura }, id),
    };
    const processor = new CaptainEvent(
      logger,
      hasura as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    processor.setData(matchId, data);
    updatedRows = [];
    await processor.process();
    return updatedRows;
  }

  // Status only labels the scenario: the captain triggers do not read it, and
  // a real Live/Finished transition needs servers, maps and results.
  async function forceStatus(matchId: string, status: string) {
    await postgres.transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE matches SET status = $1 WHERE id = $2", [
        status,
        matchId,
      ]);
    });
  }

  async function captainsOf(lineupId: string) {
    const rows = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text FROM match_lineup_players
        WHERE match_lineup_id = $1 AND captain ORDER BY steam_id`,
      [lineupId],
    );
    return rows.map((row) => row.steam_id);
  }

  // A Setup -> RegistrationClosed tournament with four registered teams, so
  // round 1 is drawn and seated by schedule_tournament_match.
  async function tournamentWith(teams: Array<{ id: string; owner: string }>) {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Competitive', id, false, true, '{TestA}', 2
       FROM map_pools WHERE type = 'Competitive' AND seed = true RETURNING id`,
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, min_role, registration_version)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL, 1) RETURNING id`,
      [fx.nextName("cup"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    const setStatus = (status: string) =>
      runAsUser(postgres, organizer, "admin", (query) =>
        query("UPDATE tournaments SET status = $1 WHERE id = $2", [
          status,
          tournament.id,
        ]),
      );
    await setStatus("RegistrationOpen");
    for (const team of teams) {
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2`,
          [tournament.id, team.id],
        ),
      );
    }
    await setStatus("RegistrationClosed");

    return postgres.query<
      Array<{ match_id: string; lineup_id: string; team_id: string }>
    >(
      `SELECT m.id AS match_id, ml.id AS lineup_id, tt.team_id
         FROM tournament_brackets tb
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN matches m ON m.id = tb.match_id
         CROSS JOIN LATERAL (VALUES (m.lineup_1_id, tb.tournament_team_id_1),
                                    (m.lineup_2_id, tb.tournament_team_id_2)) AS side(lineup_id, tournament_team_id)
         INNER JOIN match_lineups ml ON ml.id = side.lineup_id
         INNER JOIN tournament_teams tt ON tt.id = side.tournament_team_id
        WHERE ts.tournament_id = $1`,
      [tournament.id],
    );
  }

  async function teamMembers(teamId: string) {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id::text FROM team_roster WHERE team_id = $1 ORDER BY player_steam_id",
      [teamId],
    );
    return rows.map((row) => row.player_steam_id);
  }

  // A plain match where `captain` leads lineup 1 and `others` sit beside them.
  async function plainMatch(captain: string, others: Array<string>) {
    const match = await fx.match();
    await fx.lineupPlayer(match.lineup_1_id, captain);
    for (const steam of others) {
      await fx.lineupPlayer(match.lineup_1_id, steam);
    }
    expect(await captainsOf(match.lineup_1_id)).toEqual([captain]);
    return { matchId: match.id, lineupId: match.lineup_1_id };
  }

  type Scene = {
    captain: string;
    teammate: string;
    current: { matchId: string; lineupId: string };
    otherLive: { matchId: string; lineupId: string };
    finished: { matchId: string; lineupId: string };
    otherTournament: { matchId: string; lineupId: string };
  };

  // The same captain leads a lineup in four matches: the one the game server
  // reports for, another live match, a finished match and a match in an
  // unrelated tournament. Their teammate sits in two of them as a member.
  //
  // `early` is minted first, so it holds the lowest steam id in every other
  // lineup: if the captain's flag were cleared there, pick_captain would hand
  // the lineup to `early` and the assertions below would see it.
  async function scene(): Promise<Scene> {
    const early = await fx.player();
    const ownTeam = await fx.team(4);
    const field = [
      ownTeam,
      await fx.team(4),
      await fx.team(4),
      await fx.team(4),
    ];
    const seated = await tournamentWith(field);
    const own = seated.find((row) => row.team_id === ownTeam.id)!;
    const captain = ownTeam.owner;
    expect(await captainsOf(own.lineup_id)).toEqual([captain]);
    const teammate = (await teamMembers(ownTeam.id)).find(
      (steam) => steam !== captain,
    )!;

    const unrelated = await tournamentWith([
      await fx.team(4),
      await fx.team(4),
      await fx.team(4),
      await fx.team(4),
    ]);
    const otherTournament = unrelated[0];
    await runAsUser(postgres, captain, "admin", (query) =>
      query(
        "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2), ($1, $3)",
        [otherTournament.lineup_id, captain, early],
      ),
    );
    await postgres.query(
      "UPDATE match_lineup_players SET captain = true WHERE match_lineup_id = $1 AND steam_id = $2",
      [otherTournament.lineup_id, captain],
    );
    expect(await captainsOf(otherTournament.lineup_id)).toEqual([captain]);

    const otherLive = await plainMatch(captain, [early, teammate]);
    const finished = await plainMatch(captain, [early, teammate]);

    await forceStatus(own.match_id, "Live");
    await forceStatus(otherLive.matchId, "Live");
    await forceStatus(finished.matchId, "Finished");
    await forceStatus(otherTournament.match_id, "Live");

    return {
      captain,
      teammate,
      current: { matchId: own.match_id, lineupId: own.lineup_id },
      otherLive,
      finished,
      otherTournament: {
        matchId: otherTournament.match_id,
        lineupId: otherTournament.lineup_id,
      },
    };
  }

  async function expectUntouched(s: Scene) {
    expect(await captainsOf(s.otherLive.lineupId)).toEqual([s.captain]);
    expect(await captainsOf(s.finished.lineupId)).toEqual([s.captain]);
    expect(await captainsOf(s.otherTournament.lineupId)).toEqual([s.captain]);
  }

  it("a captain who releases (or disconnects in warmup) loses the captaincy in this match only", async () => {
    const s = await scene();

    const updated = await captainEvent(s.current.matchId, {
      claim: false,
      steam_id: s.captain,
      player_name: "captain",
    });

    // Only the captain's row in this match is written; pick_captain then
    // keeps the lineup at exactly one captain.
    expect(updated).toEqual([1]);
    expect(await captainsOf(s.current.lineupId)).toHaveLength(1);
    await expectUntouched(s);
  });

  it("a teammate's claim makes them captain in this match only", async () => {
    const s = await scene();

    const updated = await captainEvent(s.current.matchId, {
      claim: true,
      steam_id: s.teammate,
      player_name: "teammate",
    });

    expect(updated).toEqual([1]);

    expect(await captainsOf(s.current.lineupId)).toEqual([s.teammate]);
    await expectUntouched(s);
  });

  it("an event for a player who is not in the match changes nothing", async () => {
    const s = await scene();
    const before = await captainsOf(s.current.lineupId);

    const updated = await captainEvent(s.current.matchId, {
      claim: false,
      steam_id: await fx.player(),
      player_name: "stranger",
    });

    expect(updated).toEqual([]);

    expect(await captainsOf(s.current.lineupId)).toEqual(before);
    await expectUntouched(s);
  });
});
