import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

type Team = { id: string; owner: string };
type Tournament = { id: string; organizer: string };
type TournamentTeamIds = Map<string, string>;

describe("historical tournament roster image snapshots", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("HistoricalRosterImagesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM award_recipients");
    await postgres.query("DELETE FROM award_occurrences");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const createTournament = async (): Promise<Tournament> => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options
         (mr, best_of, type, map_pool_id, map_veto, region_veto, regions,
          number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', 3
       FROM map_pools
       WHERE type = 'Wingman' AND seed = true
       RETURNING id`,
    );
    // min_role explicitly NULL: this suite's fixture players stay at the
    // default 'user' role, and roster-insert enforcement of the column's
    // 'verified_user' default is real now (see hasura/triggers/
    // tournament_team_roster.sql), so leaving it on would block every
    // registerTeams() call below.
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
         (name, start, organizer_steam_id, match_options_id, status, min_role)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL)
       RETURNING id`,
      [fx.nextName("snapshot-cup"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages
         (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    return { id: tournament.id, organizer };
  };

  const setStatus = (
    tournament: Tournament,
    status: "RegistrationOpen" | "RegistrationClosed" | "Live",
  ) =>
    runAsUser(postgres, tournament.organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournament.id,
      ]),
    );

  const createTeams = async (targetMates = 2): Promise<Array<Team>> => [
    await fx.team(targetMates),
    await fx.team(1),
    await fx.team(1),
    await fx.team(1),
  ];

  const registerTeams = async (
    tournament: Tournament,
    teams: Array<Team>,
    registrationContext: "teamOwners" | "organizer" = "teamOwners",
  ): Promise<TournamentTeamIds> => {
    const ids: TournamentTeamIds = new Map();
    for (const team of teams) {
      const id = await runAsUser(
        postgres,
        registrationContext === "organizer" ? tournament.organizer : team.owner,
        registrationContext === "organizer" ? "tournament_organizer" : "admin",
        async (query) => {
          const [row] = (await query(
            `INSERT INTO tournament_teams (tournament_id, team_id, name)
             SELECT $1, id, name FROM teams WHERE id = $2
             RETURNING id`,
            [tournament.id, team.id],
          )) as Array<{ id: string }>;
          return row.id;
        },
      );
      ids.set(team.id, id);
    }
    return ids;
  };

  const teamPlayers = (teamId: string) =>
    postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id
       FROM team_roster
       WHERE team_id = $1
       ORDER BY player_steam_id`,
      [teamId],
    );

  const setGeneralImage = (steamId: string, path: string | null) =>
    postgres.query(
      "UPDATE players SET roster_image_url = $2 WHERE steam_id = $1",
      [steamId, path],
    );

  const setTeamImage = (teamId: string, steamId: string, path: string | null) =>
    postgres.query(
      `UPDATE team_roster
       SET roster_image_url = $3
       WHERE team_id = $1 AND player_steam_id = $2`,
      [teamId, steamId, path],
    );

  const getSnapshot = async (
    tournamentTeamId: string,
    steamId: string,
  ): Promise<string | null> => {
    const [row] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      `SELECT roster_image_url_snapshot
       FROM tournament_team_roster
       WHERE tournament_team_id = $1 AND player_steam_id = $2`,
      [tournamentTeamId, steamId],
    );
    return row.roster_image_url_snapshot;
  };

  const addLockedPlayer = async (
    tournament: Tournament,
    tournamentTeamId: string,
    imagePath: string,
  ): Promise<string> => {
    const steamId = await fx.player();
    await setGeneralImage(steamId, imagePath);
    await runAsUser(postgres, tournament.organizer, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster
           (tournament_team_id, player_steam_id, tournament_id, role)
         VALUES ($1, $2, $3, 'Member')`,
        [tournamentTeamId, steamId, tournament.id],
      ),
    );
    return steamId;
  };

  const setGeneralImagesForTeams = async (teams: Array<Team>) => {
    for (const team of teams) {
      for (const player of await teamPlayers(team.id)) {
        await setGeneralImage(
          player.player_steam_id,
          `avatars/roster-players/${player.player_steam_id}.png`,
        );
      }
    }
  };

  it("captures priority and NULL fallback without changing eligibility or overwriting locked snapshots", async () => {
    const tournament = await createTournament();
    const teams = await createTeams();
    const target = teams[0];
    const players = await teamPlayers(target.id);
    const generalPlayer = players.find(
      (player) => player.player_steam_id !== target.owner,
    )!;
    const missingPlayer = players.find(
      (player) =>
        player.player_steam_id !== target.owner &&
        player.player_steam_id !== generalPlayer.player_steam_id,
    )!;

    await setGeneralImage(
      target.owner,
      "avatars/roster-players/owner-general.png",
    );
    await setTeamImage(
      target.id,
      target.owner,
      "avatars/roster-teams/owner-specific.png",
    );
    await setGeneralImage(
      generalPlayer.player_steam_id,
      "avatars/roster-players/general-only.png",
    );

    await setStatus(tournament, "RegistrationOpen");
    const ids = await registerTeams(tournament, teams);
    const targetTournamentTeamId = ids.get(target.id)!;

    // Existing unlocked rows are not made historical merely by the migration
    // or registration copy.
    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBeNull();
    expect(
      await getSnapshot(targetTournamentTeamId, generalPlayer.player_steam_id),
    ).toBeNull();
    expect(
      await getSnapshot(targetTournamentTeamId, missingPlayer.player_steam_id),
    ).toBeNull();

    await setStatus(tournament, "RegistrationClosed");

    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBe(
      "avatars/roster-teams/owner-specific.png",
    );
    expect(
      await getSnapshot(targetTournamentTeamId, generalPlayer.player_steam_id),
    ).toBe("avatars/roster-players/general-only.png");
    expect(
      await getSnapshot(targetTournamentTeamId, missingPlayer.player_steam_id),
    ).toBeNull();

    const latePlayer = await addLockedPlayer(
      tournament,
      targetTournamentTeamId,
      "avatars/roster-players/late.png",
    );
    expect(await getSnapshot(targetTournamentTeamId, latePlayer)).toBe(
      "avatars/roster-players/late.png",
    );

    const [before] = await postgres.query<
      Array<{ eligible_at: Date | null; seed: number | null }>
    >("SELECT eligible_at, seed FROM tournament_teams WHERE id = $1", [
      targetTournamentTeamId,
    ]);
    await postgres.query(
      `UPDATE tournament_team_roster
       SET roster_image_url_snapshot = roster_image_url_snapshot
       WHERE tournament_team_id = $1 AND player_steam_id = $2`,
      [targetTournamentTeamId, target.owner],
    );
    const [after] = await postgres.query<
      Array<{ eligible_at: Date | null; seed: number | null }>
    >("SELECT eligible_at, seed FROM tournament_teams WHERE id = $1", [
      targetTournamentTeamId,
    ]);
    expect(after).toEqual(before);

    await setGeneralImage(target.owner, "avatars/roster-players/owner-new.png");
    await setTeamImage(
      target.id,
      target.owner,
      "avatars/roster-teams/owner-new.png",
    );
    await postgres.query(
      "SELECT capture_tournament_roster_image_snapshots($1)",
      [tournament.id],
    );
    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBe(
      "avatars/roster-teams/owner-specific.png",
    );
  }, 120_000);

  it("clears snapshots on a supported reopen and recaptures them on the next close", async () => {
    const tournament = await createTournament();
    const teams = await createTeams(1);
    const target = teams[0];
    await setGeneralImage(
      target.owner,
      "avatars/roster-players/reopen-general-old.png",
    );
    await setTeamImage(
      target.id,
      target.owner,
      "avatars/roster-teams/reopen-team-old.png",
    );

    await setStatus(tournament, "RegistrationOpen");
    const ids = await registerTeams(tournament, teams);
    const targetTournamentTeamId = ids.get(target.id)!;
    await setStatus(tournament, "RegistrationClosed");
    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBe(
      "avatars/roster-teams/reopen-team-old.png",
    );

    await setGeneralImage(
      target.owner,
      "avatars/roster-players/reopen-general-new.png",
    );
    await setTeamImage(
      target.id,
      target.owner,
      "avatars/roster-teams/reopen-team-new.png",
    );
    await setStatus(tournament, "RegistrationOpen");
    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBeNull();

    await setStatus(tournament, "RegistrationClosed");
    expect(await getSnapshot(targetTournamentTeamId, target.owner)).toBe(
      "avatars/roster-teams/reopen-team-new.png",
    );
  }, 120_000);

  it("captures on validated direct transitions from Setup or RegistrationOpen to Live and does not recapture from RegistrationClosed", async () => {
    const setupTournament = await createTournament();
    const setupTeams = await createTeams(1);
    const setupTarget = setupTeams[0];
    await setGeneralImage(
      setupTarget.owner,
      "avatars/roster-players/setup-direct-live.png",
    );
    const setupIds = await registerTeams(
      setupTournament,
      setupTeams,
      "organizer",
    );
    const setupTargetId = setupIds.get(setupTarget.id)!;

    await setStatus(setupTournament, "Live");
    const [setupStatus] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [setupTournament.id],
    );
    expect(setupStatus.status).toBe("Live");
    expect(await getSnapshot(setupTargetId, setupTarget.owner)).toBe(
      "avatars/roster-players/setup-direct-live.png",
    );

    const directTournament = await createTournament();
    const directTeams = await createTeams(1);
    const directTarget = directTeams[0];
    await setGeneralImage(
      directTarget.owner,
      "avatars/roster-players/direct-live.png",
    );
    await setStatus(directTournament, "RegistrationOpen");
    const directIds = await registerTeams(directTournament, directTeams);
    const directTargetId = directIds.get(directTarget.id)!;

    await setStatus(directTournament, "Live");
    const [directStatus] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [directTournament.id],
    );
    expect(directStatus.status).toBe("Live");
    expect(await getSnapshot(directTargetId, directTarget.owner)).toBe(
      "avatars/roster-players/direct-live.png",
    );

    const closedTournament = await createTournament();
    const closedTeams = await createTeams(1);
    const closedTarget = closedTeams[0];
    await setGeneralImage(
      closedTarget.owner,
      "avatars/roster-players/closed-old.png",
    );
    await setStatus(closedTournament, "RegistrationOpen");
    const closedIds = await registerTeams(closedTournament, closedTeams);
    const closedTargetId = closedIds.get(closedTarget.id)!;
    await setStatus(closedTournament, "RegistrationClosed");
    await setGeneralImage(
      closedTarget.owner,
      "avatars/roster-players/closed-new.png",
    );

    await setStatus(closedTournament, "Live");
    expect(await getSnapshot(closedTargetId, closedTarget.owner)).toBe(
      "avatars/roster-players/closed-old.png",
    );
  }, 120_000);

  it("maps both tournament sides, recomputes pre-play moves, and preserves Live/Finished history", async () => {
    const tournament = await createTournament();
    const teams = await createTeams(1);
    await setGeneralImagesForTeams(teams);
    await setStatus(tournament, "RegistrationOpen");
    const ids = await registerTeams(tournament, teams);
    await setStatus(tournament, "RegistrationClosed");

    const [bracket] = await postgres.query<
      Array<{
        match_id: string;
        lineup_1_id: string;
        lineup_2_id: string;
        tournament_team_id_1: string;
        tournament_team_id_2: string;
      }>
    >(
      `SELECT tb.match_id, m.lineup_1_id, m.lineup_2_id,
              tb.tournament_team_id_1, tb.tournament_team_id_2
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       INNER JOIN matches m ON m.id = tb.match_id
       WHERE ts.tournament_id = $1
         AND tb.tournament_team_id_1 IS NOT NULL
         AND tb.tournament_team_id_2 IS NOT NULL
       ORDER BY tb.round, tb.match_number
       LIMIT 1`,
      [tournament.id],
    );

    const lineupPlayer = async (lineupId: string, tournamentTeamId: string) => {
      const [row] = await postgres.query<
        Array<{
          id: string;
          steam_id: string;
          roster_image_url_snapshot: string | null;
          tournament_snapshot: string | null;
        }>
      >(
        `SELECT mlp.id, mlp.steam_id, mlp.roster_image_url_snapshot,
                ttr.roster_image_url_snapshot AS tournament_snapshot
         FROM match_lineup_players mlp
         INNER JOIN tournament_team_roster ttr
           ON ttr.tournament_team_id = $2
          AND ttr.player_steam_id = mlp.steam_id
         WHERE mlp.match_lineup_id = $1
         ORDER BY mlp.steam_id
         LIMIT 1`,
        [lineupId, tournamentTeamId],
      );
      return row;
    };

    const side1 = await lineupPlayer(
      bracket.lineup_1_id,
      bracket.tournament_team_id_1,
    );
    const side2 = await lineupPlayer(
      bracket.lineup_2_id,
      bracket.tournament_team_id_2,
    );
    expect(side1.roster_image_url_snapshot).toBe(side1.tournament_snapshot);
    expect(side1.roster_image_url_snapshot).not.toBeNull();
    expect(side2.roster_image_url_snapshot).toBe(side2.tournament_snapshot);
    expect(side2.roster_image_url_snapshot).not.toBeNull();

    const nonTournamentMatch = await fx.match({ type: "Wingman" });
    const nonTournamentPlayer = await fx.player();
    await postgres.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       VALUES ($1, $2)`,
      [nonTournamentMatch.lineup_1_id, nonTournamentPlayer],
    );
    const [nonTournamentRow] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      `SELECT roster_image_url_snapshot
       FROM match_lineup_players
       WHERE match_lineup_id = $1 AND steam_id = $2`,
      [nonTournamentMatch.lineup_1_id, nonTournamentPlayer],
    );
    expect(nonTournamentRow.roster_image_url_snapshot).toBeNull();

    const steamReplacement = await addLockedPlayer(
      tournament,
      bracket.tournament_team_id_1,
      "avatars/roster-players/preplay-steam.png",
    );
    await postgres.query(
      "UPDATE match_lineup_players SET steam_id = $2 WHERE id = $1",
      [side1.id, steamReplacement],
    );
    const [steamReassigned] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      "SELECT roster_image_url_snapshot FROM match_lineup_players WHERE id = $1",
      [side1.id],
    );
    expect(steamReassigned.roster_image_url_snapshot).toBe(
      "avatars/roster-players/preplay-steam.png",
    );

    const lineupReplacement = await addLockedPlayer(
      tournament,
      bracket.tournament_team_id_2,
      "avatars/roster-players/preplay-lineup.png",
    );
    const sourceMatch = await fx.match({ type: "Wingman" });
    const [sourceRow] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       VALUES ($1, $2)
       RETURNING id`,
      [sourceMatch.lineup_1_id, lineupReplacement],
    );
    await runAsUser(postgres, tournament.organizer, "admin", (query) =>
      query("DELETE FROM match_lineup_players WHERE id = $1", [side2.id]),
    );
    await postgres.query(
      "UPDATE match_lineup_players SET match_lineup_id = $2 WHERE id = $1",
      [sourceRow.id, bracket.lineup_2_id],
    );
    const [lineupReassigned] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      "SELECT roster_image_url_snapshot FROM match_lineup_players WHERE id = $1",
      [sourceRow.id],
    );
    expect(lineupReassigned.roster_image_url_snapshot).toBe(
      "avatars/roster-players/preplay-lineup.png",
    );

    const liveReplacement = await addLockedPlayer(
      tournament,
      bracket.tournament_team_id_1,
      "avatars/roster-players/live-replacement.png",
    );
    await postgres.query(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT m.id, mp.map_id, 1
       FROM matches m
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
       WHERE m.id = $1
       ORDER BY mp.map_id
       LIMIT 1`,
      [bracket.match_id],
    );
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      bracket.match_id,
    ]);
    await postgres.query(
      "UPDATE match_lineup_players SET steam_id = $2 WHERE id = $1",
      [side1.id, liveReplacement],
    );
    const [liveRow] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      "SELECT roster_image_url_snapshot FROM match_lineup_players WHERE id = $1",
      [side1.id],
    );
    expect(liveRow.roster_image_url_snapshot).toBe(
      "avatars/roster-players/preplay-steam.png",
    );

    const finishedReplacement = await addLockedPlayer(
      tournament,
      bracket.tournament_team_id_1,
      "avatars/roster-players/finished-replacement.png",
    );
    await postgres.query(
      "UPDATE matches SET status = 'Finished' WHERE id = $1",
      [bracket.match_id],
    );
    await postgres.query(
      "UPDATE match_lineup_players SET steam_id = $2 WHERE id = $1",
      [side1.id, finishedReplacement],
    );
    const [finishedRow] = await postgres.query<
      Array<{ roster_image_url_snapshot: string | null }>
    >(
      "SELECT roster_image_url_snapshot FROM match_lineup_players WHERE id = $1",
      [side1.id],
    );
    expect(finishedRow.roster_image_url_snapshot).toBe(
      "avatars/roster-players/preplay-steam.png",
    );

    expect(ids.size).toBe(4);
  }, 120_000);
});
