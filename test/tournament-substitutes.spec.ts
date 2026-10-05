import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournaments.substitutes_enabled, adapted from 5Stack's
// test/tournament-substitutes.spec.ts (MIT). The substitute ALLOWANCE stays
// match_options.number_of_substitutes (the web fills it from the global team
// substitute setting); the per-tournament flag only switches it on or off.
// With an allowance of 2: Competitive 5 / 7, Wingman 2 / 4, Duel always 1.
describe("tournament substitutes (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentSubstitutesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199990000000n);
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

  type MatchType = "Competitive" | "Wingman" | "Duel";

  const createTournament = async ({
    type,
    substitutes,
    substitutesEnabled,
  }: {
    type: MatchType;
    substitutes: number;
    substitutesEnabled?: boolean;
  }) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, $1, id, false, true, '{TestA}', $2
       FROM map_pools WHERE type = $1 AND seed = true RETURNING id`,
      [type, substitutes],
    );
    // min_role NULL: fixture players are plain users (see tournament-fixtures).
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      substitutesEnabled === undefined
        ? `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, min_role, registration_version)
           VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL, 1) RETURNING id`
        : `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, min_role, substitutes_enabled, registration_version)
           VALUES ($1, now() + interval '1 day', $2, $3, 'Setup', NULL, $4, 1) RETURNING id`,
      substitutesEnabled === undefined
        ? [fx.nextName("cup"), organizer, options.id]
        : [fx.nextName("cup"), organizer, options.id, substitutesEnabled],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    return { id: tournament.id, organizer, optionsId: options.id };
  };

  const setStatus = (tournamentId: string, organizer: string, status: string) =>
    runAsUser(postgres, organizer, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const setSubstitutesEnabled = (tournamentId: string, enabled: boolean) =>
    postgres.query(
      "UPDATE tournaments SET substitutes_enabled = $1 WHERE id = $2",
      [enabled, tournamentId],
    );

  const registerTeam = (
    tournamentId: string,
    team: { id: string; owner: string },
  ) =>
    runAsUser(postgres, team.owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
        [tournamentId, team.id],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const addRosterPlayer = (
    tournamentId: string,
    tournamentTeamId: string,
    owner: string,
  ) =>
    runAsUser(postgres, owner, "admin", async (query) => {
      const player = await fx.player();
      await query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, player, tournamentId],
      );
    });

  const rosterSteamIds = async (tournamentTeamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id FROM tournament_team_roster WHERE tournament_team_id = $1",
      [tournamentTeamId],
    );
    return rows.map((row) => row.player_steam_id);
  };

  const lineupSizes = async (tournamentId: string) => {
    const [row] = await postgres.query<
      Array<{ min_players: number; max_players: number }>
    >(
      `SELECT tournament_min_players_per_lineup(t) AS min_players,
              tournament_max_players_per_lineup(t) AS max_players
       FROM tournaments t WHERE t.id = $1`,
      [tournamentId],
    );
    return row;
  };

  const seedBracket = async (
    tournament: { id: string; organizer: string },
    mates: number,
  ) => {
    await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await registerTeam(tournament.id, await fx.team(mates));
    }
    await setStatus(tournament.id, tournament.organizer, "RegistrationClosed");

    return postgres.query<
      Array<{
        id: string;
        match_options_id: string;
        lineup_1_id: string;
        lineup_2_id: string;
        max_players: number;
      }>
    >(
      `SELECT m.id, m.match_options_id, m.lineup_1_id, m.lineup_2_id,
              match_max_players_per_lineup(m) AS max_players
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       INNER JOIN matches m ON m.id = tb.match_id
       WHERE ts.tournament_id = $1
       ORDER BY tb.round, tb.match_number`,
      [tournament.id],
    );
  };

  const seatedCount = async (lineupId: string) => {
    const [row] = await postgres.query<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM match_lineup_players WHERE match_lineup_id = $1",
      [lineupId],
    );
    return row.count;
  };

  describe("capacity with an allowance of 2", () => {
    it.each<[MatchType, boolean, number, number]>([
      ["Competitive", false, 5, 5],
      ["Competitive", true, 5, 7],
      ["Wingman", false, 2, 2],
      ["Wingman", true, 2, 4],
      ["Duel", false, 1, 1],
      ["Duel", true, 1, 1],
    ])("%s, substitutes %s: min %i, max %i", async (type, enabled, min, max) => {
      const tournament = await createTournament({
        type,
        substitutes: 2,
        substitutesEnabled: enabled,
      });
      expect(await lineupSizes(tournament.id)).toEqual({
        min_players: min,
        max_players: max,
      });
    });

    it("is per tournament: A off, B on, C off are independent", async () => {
      const a = await createTournament({ type: "Competitive", substitutes: 2, substitutesEnabled: false });
      const b = await createTournament({ type: "Competitive", substitutes: 2, substitutesEnabled: true });
      const c = await createTournament({ type: "Competitive", substitutes: 2, substitutesEnabled: false });

      expect((await lineupSizes(a.id)).max_players).toBe(5);
      expect((await lineupSizes(b.id)).max_players).toBe(7);
      expect((await lineupSizes(c.id)).max_players).toBe(5);

      await setSubstitutesEnabled(a.id, true);
      expect((await lineupSizes(a.id)).max_players).toBe(7);
      expect((await lineupSizes(c.id)).max_players).toBe(5);
    });
  });

  describe("Duel tournaments", () => {
    it("registering a team rosters only the captain", async () => {
      const tournament = await createTournament({ type: "Duel", substitutes: 2 });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(2);

      const tournamentTeamId = await registerTeam(tournament.id, team);

      expect(await rosterSteamIds(tournamentTeamId)).toEqual([team.owner]);
    });

    it("rejects a stand-in added to the roster", async () => {
      const tournament = await createTournament({ type: "Duel", substitutes: 2 });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(0);
      const tournamentTeamId = await registerTeam(tournament.id, team);

      await expect(
        addRosterPlayer(tournament.id, tournamentTeamId, team.owner),
      ).rejects.toThrow(/too many players/i);
    });

    it("seats one player per side and refuses a stand-in on the match", async () => {
      const tournament = await createTournament({ type: "Duel", substitutes: 2 });

      const matches = await seedBracket(tournament, 2);

      expect(matches.length).toBe(2);
      for (const match of matches) {
        expect(match.max_players).toBe(1);
        expect(await seatedCount(match.lineup_1_id)).toBe(1);
        expect(await seatedCount(match.lineup_2_id)).toBe(1);
      }
      await expect(fx.lineupPlayer(matches[0].lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });
  });

  describe("substitutes_enabled", () => {
    it("defaults to on, so existing tournaments keep their capacity", async () => {
      const tournament = await createTournament({ type: "Wingman", substitutes: 2 });

      const [row] = await postgres.query<Array<{ substitutes_enabled: boolean }>>(
        "SELECT substitutes_enabled FROM tournaments WHERE id = $1",
        [tournament.id],
      );
      expect(row.substitutes_enabled).toBe(true);
      expect(await lineupSizes(tournament.id)).toEqual({ min_players: 2, max_players: 4 });
    });

    it("off then on again restores the configured capacity", async () => {
      const tournament = await createTournament({ type: "Wingman", substitutes: 2 });

      await setSubstitutesEnabled(tournament.id, false);
      expect(await lineupSizes(tournament.id)).toEqual({ min_players: 2, max_players: 2 });

      await setSubstitutesEnabled(tournament.id, true);
      expect(await lineupSizes(tournament.id)).toEqual({ min_players: 2, max_players: 4 });
    });

    it("off: registration rosters and scheduled matches only take the starting lineup", async () => {
      const tournament = await createTournament({ type: "Wingman", substitutes: 2 });
      await setSubstitutesEnabled(tournament.id, false);

      // Teams of 4 (owner + 3): only the starting 2 are rostered and seated.
      const matches = await seedBracket(tournament, 3);

      const teams = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1",
        [tournament.id],
      );
      expect(teams.length).toBe(4);
      for (const team of teams) {
        expect((await rosterSteamIds(team.id)).length).toBe(2);
      }
      expect(matches.length).toBe(2);
      for (const match of matches) {
        expect(match.max_players).toBe(2);
        expect(await seatedCount(match.lineup_1_id)).toBe(2);
        expect(await seatedCount(match.lineup_2_id)).toBe(2);
      }
      await expect(fx.lineupPlayer(matches[0].lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });

    it("on: a Competitive match seats the starters plus substitutes, up to 7", async () => {
      const tournament = await createTournament({ type: "Competitive", substitutes: 2 });

      // Teams of 8 (owner + 7): the roster and the match cap at 5 + 2.
      const matches = await seedBracket(tournament, 7);

      for (const match of matches) {
        expect(match.max_players).toBe(7);
        expect(await seatedCount(match.lineup_1_id)).toBe(7);
        expect(await seatedCount(match.lineup_2_id)).toBe(7);
      }
    });

    it("off: over-cap roster additions are rejected", async () => {
      const tournament = await createTournament({
        type: "Wingman",
        substitutes: 2,
        substitutesEnabled: false,
      });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(1);
      const tournamentTeamId = await registerTeam(tournament.id, team);
      expect((await rosterSteamIds(tournamentTeamId)).length).toBe(2);

      await expect(
        addRosterPlayer(tournament.id, tournamentTeamId, team.owner),
      ).rejects.toThrow(/too many players/i);
    });

    it("can be turned back on but not off once registration has closed", async () => {
      const tournament = await createTournament({ type: "Wingman", substitutes: 2 });
      await seedBracket(tournament, 1);

      await expect(setSubstitutesEnabled(tournament.id, false)).rejects.toThrow(
        /only be turned off before registration closes/i,
      );

      const withoutSubstitutes = await createTournament({ type: "Wingman", substitutes: 2 });
      await setSubstitutesEnabled(withoutSubstitutes.id, false);
      await seedBracket(withoutSubstitutes, 1);

      await expect(setSubstitutesEnabled(withoutSubstitutes.id, true)).resolves.toBeDefined();
      expect((await lineupSizes(withoutSubstitutes.id)).max_players).toBe(4);
    });

    it("off during registration: a roster already over the new cap can still drop its stand-ins", async () => {
      const tournament = await createTournament({ type: "Wingman", substitutes: 1 });
      await setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
      const team = await fx.team(2);
      const tournamentTeamId = await registerTeam(tournament.id, team);
      expect((await rosterSteamIds(tournamentTeamId)).length).toBe(3);

      await setSubstitutesEnabled(tournament.id, false);

      // Not stranded: shedding players is never blocked by the lowered cap.
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `DELETE FROM tournament_team_roster
           WHERE tournament_team_id = $1 AND player_steam_id <> $2`,
          [tournamentTeamId, team.owner],
        ),
      );
      expect(await rosterSteamIds(tournamentTeamId)).toEqual([team.owner]);

      // Below the minimum the team is simply not eligible, and refilling up to
      // the new cap works.
      const [team_row] = await postgres.query<Array<{ eligible_at: string | null }>>(
        "SELECT eligible_at FROM tournament_teams WHERE id = $1",
        [tournamentTeamId],
      );
      expect(team_row.eligible_at).toBeNull();
      await addRosterPlayer(tournament.id, tournamentTeamId, team.owner);
      expect((await rosterSteamIds(tournamentTeamId)).length).toBe(2);
      await expect(
        addRosterPlayer(tournament.id, tournamentTeamId, team.owner),
      ).rejects.toThrow(/too many players/i);
    });
  });

  describe("Solo Random (individual registration) is unaffected", () => {
    // Team generation sizes teams from min_players_per_lineup (see
    // tournaments.controller / ProcessTournamentAttendance), which the flag
    // never changes; OFF only removes slots a generated team never fills.
    it.each<[MatchType, number]>([
      ["Competitive", 5],
      ["Wingman", 2],
    ])("%s: generated team size stays %i with substitutes on or off", async (type, size) => {
      for (const enabled of [true, false]) {
        const tournament = await createTournament({ type, substitutes: 2, substitutesEnabled: enabled });
        await postgres.query(
          "UPDATE match_options SET individual_registration_enabled = true WHERE id = $1",
          [tournament.optionsId],
        );
        const sizes = await lineupSizes(tournament.id);
        expect(sizes.min_players).toBe(size);
        expect(sizes.max_players).toBeGreaterThanOrEqual(size);
      }
    });
  });

  describe("outside tournaments", () => {
    it("a Duel match keeps its configured substitute slots", async () => {
      const match = await fx.match({ type: "Duel", substitutes: 2 });

      const [row] = await postgres.query<Array<{ max_players: number }>>(
        "SELECT match_max_players_per_lineup(m) AS max_players FROM matches m WHERE m.id = $1",
        [match.id],
      );
      expect(row.max_players).toBe(3);
    });

    it("a Competitive match keeps the global allowance", async () => {
      const match = await fx.match({ type: "Competitive", substitutes: 2 });

      const [row] = await postgres.query<Array<{ max_players: number }>>(
        "SELECT match_max_players_per_lineup(m) AS max_players FROM matches m WHERE m.id = $1",
        [match.id],
      );
      expect(row.max_players).toBe(7);
    });
  });
});
