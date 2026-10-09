import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// The whole substitute path in one tournament: a roster swap before the match,
// the lineup that results, who actually plays, and who is rated afterwards.
// A match seats the starting size only; substitutes stay on the tournament
// roster, are not rated for a match they did not start, and nothing about a
// normal 5-player match changes.
describe("substitute flow: roster swap, lineup, play, ELO (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentSubstituteFlowTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199985000000n);
    tournaments = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const seats = async (lineupId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      )
    ).map((r) => r.steam_id);

  const rated = async (matchId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM player_elo WHERE match_id = $1 ORDER BY steam_id",
        [matchId],
      )
    ).map((r) => r.steam_id);

  it("a substitute swapped in before the match plays and is rated; the idle and the removed are not", async () => {
    const t = await tournaments.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      "Competitive",
    );
    await postgres.query(
      `UPDATE match_options SET number_of_substitutes = 2
        WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tournaments.registerTeam(t.id, await fx.team(5));
    }
    await tournaments.setStatus(t.id, t.organizer, "RegistrationClosed");

    const [bracket] = await postgres.query<
      Array<{
        match_id: string;
        lineup_1_id: string;
        lineup_2_id: string;
        tt1: string;
      }>
    >(
      `SELECT tb.match_id, m.lineup_1_id, m.lineup_2_id, tb.tournament_team_id_1 AS tt1
         FROM tournament_brackets tb
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = $1 AND tb.match_id IS NOT NULL
        ORDER BY tb.round, tb.match_number LIMIT 1`,
      [t.id],
    );

    // Both sides seat their five starters; the sixth rostered player stays on
    // the bench of the tournament roster.
    const team1Before = await seats(bracket.lineup_1_id);
    const team2 = await seats(bracket.lineup_2_id);
    expect(team1Before).toHaveLength(5);
    expect(team2).toHaveLength(5);
    const rosterOf = async (tournamentTeamId: string) =>
      (
        await postgres.query<Array<{ steam_id: string }>>(
          "SELECT player_steam_id::text AS steam_id FROM tournament_team_roster WHERE tournament_team_id = $1",
          [tournamentTeamId],
        )
      ).map((r) => r.steam_id);
    const bench1 = (await rosterOf(bracket.tt1)).filter(
      (s) => !team1Before.includes(s),
    );
    expect(bench1).toHaveLength(1);

    // Team 1's organizer pulls one starter off the roster; the lineup follows,
    // and the substitute is now one of the five who play.
    const [captain] = await postgres.query<Array<{ captain_steam_id: string }>>(
      "SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1",
      [bracket.tt1],
    );
    const removed = team1Before.find((s) => s !== captain.captain_steam_id)!;
    await runAsUser(postgres, t.organizer, "admin", (query) =>
      query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [bracket.tt1, removed],
      ),
    );
    const team1 = await seats(bracket.lineup_1_id);
    expect(team1).toHaveLength(5);
    expect(team1).not.toContain(removed);
    expect(team1).toContain(bench1[0]);
    expect(new Set(team1).size).toBe(5);
    const [captains] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM match_lineup_players WHERE match_lineup_id = $1 AND captain",
      [bracket.lineup_1_id],
    );
    expect(captains.count).toBe(1);

    // Play: both sides' five.
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [bracket.match_id],
    );
    const ctx = { matchId: bracket.match_id, mapId: map.id };
    const team2Active = team2;
    for (let i = 0; i < 5; i++) {
      await fx.kill(ctx, team1[i], team2Active[i]);
      await fx.kill(ctx, team2Active[i], team1[i]);
    }

    await tournaments.winMatch(bracket.match_id);
    await postgres.query(
      "UPDATE matches SET ended_at = now() - interval '1 hour' WHERE id = $1",
      [bracket.match_id],
    );
    await postgres.query("SELECT generate_player_elo_for_match($1)", [
      bracket.match_id,
    ]);

    const ratedPlayers = await rated(bracket.match_id);
    expect(new Set(ratedPlayers)).toEqual(new Set([...team1, ...team2Active]));
    expect(ratedPlayers).not.toContain(removed);
    // One rating row per participant: no duplicate stats.
    expect(ratedPlayers).toHaveLength(10);
    expect(new Set(ratedPlayers).size).toBe(10);
  }, 120_000);

  it("a normal 5-player match is rated exactly as before, whether or not every player has events", async () => {
    const t = await tournaments.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      "Competitive",
    );
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tournaments.registerTeam(t.id, await fx.team(4));
    }
    await tournaments.setStatus(t.id, t.organizer, "RegistrationClosed");
    const [bracket] = await postgres.query<
      Array<{ match_id: string; lineup_1_id: string; lineup_2_id: string }>
    >(
      `SELECT tb.match_id, m.lineup_1_id, m.lineup_2_id
         FROM tournament_brackets tb
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = $1 AND tb.match_id IS NOT NULL
        ORDER BY tb.round, tb.match_number LIMIT 1`,
      [t.id],
    );
    const one = await seats(bracket.lineup_1_id);
    const two = await seats(bracket.lineup_2_id);
    expect(one).toHaveLength(5);
    expect(two).toHaveLength(5);

    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [bracket.match_id],
    );
    // Only some players have events; at the starting size everyone is rated.
    await fx.kill({ matchId: bracket.match_id, mapId: map.id }, one[0], two[0]);
    await tournaments.winMatch(bracket.match_id);
    await postgres.query(
      "UPDATE matches SET ended_at = now() - interval '1 hour' WHERE id = $1",
      [bracket.match_id],
    );
    await postgres.query("SELECT generate_player_elo_for_match($1)", [
      bracket.match_id,
    ]);

    expect(new Set(await rated(bracket.match_id))).toEqual(
      new Set([...one, ...two]),
    );
  }, 120_000);
});
