import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A tournament roster change must carry into a match that exists but has not
// started. Round-1 matches are created when registration closes, so an
// organizer fixing a roster between close and start (or before a later round
// is played) used to leave the match lineup seating the old players.
//
// Matches that are underway or finished are never rewritten, and neither are
// the roster snapshots they hold.
describe("tournament roster changes refresh pre-start match lineups (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentRosterLineupRefreshTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199980000000n);
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

  type Fixture = {
    tournamentId: string;
    organizer: string;
    matchId: string;
    bracketId: string;
    lineup1: string;
    lineup2: string;
    tt1: string;
    tt2: string;
    team1Owner: string;
  };

  // Four Competitive teams with `mates` extra members each; allowance of 2, so
  // the roster and the match cap at 7. Registration is closed, so round 1
  // exists and is seated.
  const seed = async (mates: number): Promise<Fixture> => {
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

    let team1Owner = "";
    for (let i = 0; i < 4; i++) {
      const team = await fx.team(mates);
      if (i === 0) team1Owner = team.owner;
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2`,
          [tournament.id, team.id],
        ),
      );
    }
    await setStatus("RegistrationClosed");

    const [bracket] = await postgres.query<
      Array<{
        id: string;
        match_id: string;
        tournament_team_id_1: string;
        tournament_team_id_2: string;
        lineup_1_id: string;
        lineup_2_id: string;
      }>
    >(
      `SELECT tb.id, tb.match_id, tb.tournament_team_id_1, tb.tournament_team_id_2,
              m.lineup_1_id, m.lineup_2_id
       FROM tournament_brackets tb
       INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       INNER JOIN matches m ON m.id = tb.match_id
       WHERE ts.tournament_id = $1 AND tb.match_id IS NOT NULL
       ORDER BY tb.round, tb.match_number LIMIT 1`,
      [tournament.id],
    );

    return {
      tournamentId: tournament.id,
      organizer,
      matchId: bracket.match_id,
      bracketId: bracket.id,
      lineup1: bracket.lineup_1_id,
      lineup2: bracket.lineup_2_id,
      tt1: bracket.tournament_team_id_1,
      tt2: bracket.tournament_team_id_2,
      team1Owner,
    };
  };

  const seated = async (lineupId: string) => {
    const rows = await postgres.query<
      Array<{ steam_id: string; captain: boolean; checked_in: boolean }>
    >(
      `SELECT steam_id::text, captain, checked_in
       FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id`,
      [lineupId],
    );
    return rows;
  };

  const roster = async (tournamentTeamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id::text FROM tournament_team_roster WHERE tournament_team_id = $1",
      [tournamentTeamId],
    );
    return rows.map((r) => r.player_steam_id);
  };

  const captainOf = async (tournamentTeamId: string) => {
    const [row] = await postgres.query<Array<{ captain_steam_id: string }>>(
      "SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1",
      [tournamentTeamId],
    );
    return row.captain_steam_id;
  };

  const removeFromRoster = (
    f: Fixture,
    tournamentTeamId: string,
    steam: string,
  ) =>
    runAsUser(postgres, f.organizer, "admin", (query) =>
      query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [tournamentTeamId, steam],
      ),
    );

  const addToRoster = async (f: Fixture, tournamentTeamId: string) => {
    const player = await fx.player();
    await runAsUser(postgres, f.organizer, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, player, f.tournamentId],
      ),
    );
    return player;
  };

  const expectSameSeatsAsRoster = async (f: Fixture) => {
    const lineup = (await seated(f.lineup1)).map((r) => r.steam_id).sort();
    expect(lineup).toEqual((await roster(f.tt1)).sort());
    expect(new Set(lineup).size).toBe(lineup.length);
  };

  it("seats the whole roster when the draw is published (baseline)", async () => {
    const f = await seed(5);
    expect((await seated(f.lineup1)).length).toBe(6);
    await expectSameSeatsAsRoster(f);
  });

  it("a removed substitute no longer stays seated", async () => {
    const f = await seed(5);
    const captain = await captainOf(f.tt1);
    const victim = (await roster(f.tt1)).find((s) => s !== captain)!;

    await removeFromRoster(f, f.tt1, victim);

    const lineup = await seated(f.lineup1);
    expect(lineup.map((r) => r.steam_id)).not.toContain(victim);
    expect(lineup.length).toBe(5);
    await expectSameSeatsAsRoster(f);
  });

  it("a newly added eligible player is seated, up to the cap", async () => {
    const f = await seed(5);
    const added = await addToRoster(f, f.tt1);

    const lineup = await seated(f.lineup1);
    expect(lineup.map((r) => r.steam_id)).toContain(added);
    expect(lineup.length).toBe(7);
    await expectSameSeatsAsRoster(f);
  });

  it("keeps exactly one captain, the tournament captain, through a swap", async () => {
    const f = await seed(5);
    const captain = await captainOf(f.tt1);
    const victim = (await roster(f.tt1)).find((s) => s !== captain)!;

    await removeFromRoster(f, f.tt1, victim);
    await addToRoster(f, f.tt1);

    const lineup = await seated(f.lineup1);
    const captains = lineup.filter((r) => r.captain).map((r) => r.steam_id);
    expect(captains).toEqual([captain]);
  });

  it("a player swapped in does not inherit a previous player's check-in", async () => {
    const f = await seed(5);
    await postgres.query(
      "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
      [f.lineup1],
    );
    const captain = await captainOf(f.tt1);
    const victim = (await roster(f.tt1)).find((s) => s !== captain)!;
    await removeFromRoster(f, f.tt1, victim);
    const added = await addToRoster(f, f.tt1);

    const lineup = await seated(f.lineup1);
    expect(lineup.find((r) => r.steam_id === added)?.checked_in).toBe(false);
    // The players who were already seated and checked in keep their check-in.
    expect(
      lineup.filter((r) => r.steam_id !== added).every((r) => r.checked_in),
    ).toBe(true);
  });

  it("only touches the lineups of the team that changed", async () => {
    const f = await seed(5);
    const before = (await seated(f.lineup2)).map((r) => r.steam_id);
    const captain = await captainOf(f.tt1);
    await removeFromRoster(
      f,
      f.tt1,
      (await roster(f.tt1)).find((s) => s !== captain)!,
    );
    expect((await seated(f.lineup2)).map((r) => r.steam_id)).toEqual(before);
  });

  it.each(["Veto", "WaitingForServer", "Live", "Finished"])(
    "does not rewrite a match that is %s",
    async (status) => {
      const f = await seed(5);
      const captain = await captainOf(f.tt1);
      const victim = (await roster(f.tt1)).find((s) => s !== captain)!;
      const before = await seated(f.lineup1);

      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
        f.matchId,
        status,
      ]);
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");

      await removeFromRoster(f, f.tt1, victim);
      await addToRoster(f, f.tt1);

      expect(await seated(f.lineup1)).toEqual(before);
    },
  );

  it("keeps the roster image snapshot of a player who was already seated", async () => {
    const f = await seed(5);
    const captain = await captainOf(f.tt1);
    const keep = (await roster(f.tt1)).find((s) => s === captain)!;
    await postgres.query(
      "UPDATE match_lineup_players SET roster_image_url_snapshot = 'snap/keep.png' WHERE match_lineup_id = $1 AND steam_id = $2",
      [f.lineup1, keep],
    );

    await removeFromRoster(
      f,
      f.tt1,
      (await roster(f.tt1)).find((s) => s !== captain)!,
    );

    const [row] = await postgres.query<
      Array<{ roster_image_url_snapshot: string }>
    >(
      "SELECT roster_image_url_snapshot FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2",
      [f.lineup1, keep],
    );
    expect(row.roster_image_url_snapshot).toBe("snap/keep.png");
  });

  const setTournamentCaptain = (
    f: Fixture,
    tournamentTeamId: string,
    steam: string,
  ) =>
    runAsUser(postgres, f.organizer, "admin", (query) =>
      query("UPDATE tournament_teams SET captain_steam_id = $2 WHERE id = $1", [
        tournamentTeamId,
        steam,
      ]),
    );

  it("a new tournament captain becomes the lineup captain, with exactly one captain", async () => {
    const f = await seed(5);
    const oldCaptain = await captainOf(f.tt1);
    const newCaptain = (await roster(f.tt1)).find((s) => s !== oldCaptain)!;

    await setTournamentCaptain(f, f.tt1, newCaptain);

    const lineup = await seated(f.lineup1);
    expect(lineup.filter((r) => r.captain).map((r) => r.steam_id)).toEqual([
      newCaptain,
    ]);
    expect(lineup.length).toBe(6);
    await expectSameSeatsAsRoster(f);
  });

  it("a captain change does not alter the other team's lineup or captain", async () => {
    const f = await seed(5);
    const before = await seated(f.lineup2);
    const oldCaptain = await captainOf(f.tt1);
    await setTournamentCaptain(
      f,
      f.tt1,
      (await roster(f.tt1)).find((s) => s !== oldCaptain)!,
    );
    expect(await seated(f.lineup2)).toEqual(before);
  });

  it.each(["Veto", "Live", "Finished"])(
    "a captain change does not rewrite a match that is %s",
    async (status) => {
      const f = await seed(5);
      const oldCaptain = await captainOf(f.tt1);
      const before = await seated(f.lineup1);

      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
        f.matchId,
        status,
      ]);
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");

      await setTournamentCaptain(
        f,
        f.tt1,
        (await roster(f.tt1)).find((s) => s !== oldCaptain)!,
      );

      expect(await seated(f.lineup1)).toEqual(before);
    },
  );

  it("a team at exactly the starting size swaps a player by adding first, and the guard against dropping below it is unchanged", async () => {
    const f = await seed(4); // exactly 5
    const captain = await captainOf(f.tt1);
    const victim = (await roster(f.tt1)).find((s) => s !== captain)!;

    // Dropping straight to 4 is refused by the existing minimum-lineup guard.
    await expect(removeFromRoster(f, f.tt1, victim)).rejects.toThrow(
      /below the minimum lineup/i,
    );
    expect((await seated(f.lineup1)).length).toBe(5);

    const added = await addToRoster(f, f.tt1);
    await removeFromRoster(f, f.tt1, victim);

    const lineup = (await seated(f.lineup1)).map((r) => r.steam_id);
    expect(lineup).toContain(added);
    expect(lineup).not.toContain(victim);
    expect(lineup.length).toBe(5);
    await expectSameSeatsAsRoster(f);
  });

  describe("a removed tournament captain", () => {
    const permanentCaptain = async (tournamentTeamId: string) => {
      const [row] = await postgres.query<Array<{ captain_steam_id: string }>>(
        `SELECT t.captain_steam_id::text
           FROM tournament_teams tt JOIN teams t ON t.id = tt.team_id
          WHERE tt.id = $1`,
        [tournamentTeamId],
      );
      return row.captain_steam_id;
    };

    const setRosterRole = (
      f: Fixture,
      tournamentTeamId: string,
      steam: string,
      role: string,
    ) =>
      runAsUser(postgres, f.organizer, "admin", (query) =>
        query(
          "UPDATE tournament_team_roster SET role = $3 WHERE tournament_team_id = $1 AND player_steam_id = $2",
          [tournamentTeamId, steam, role],
        ),
      );

    const others = async (tournamentTeamId: string, removed: string) =>
      (await roster(tournamentTeamId)).filter((s) => s !== removed).sort();

    it("hands the captaincy to a remaining player, deterministically (lowest steam id)", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);
      const expected = (await others(f.tt1, removed))[0];

      await removeFromRoster(f, f.tt1, removed);

      expect(await captainOf(f.tt1)).toBe(expected);
      expect(await roster(f.tt1)).toContain(await captainOf(f.tt1));
    });

    it("prefers an eligible roster Admin", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);
      const remaining = await others(f.tt1, removed);
      const admin = remaining[remaining.length - 1]; // not the lowest id
      await setRosterRole(f, f.tt1, admin, "Admin");

      await removeFromRoster(f, f.tt1, removed);

      expect(await captainOf(f.tt1)).toBe(admin);
    });

    it("skips a roster Admin who is under an admin ban", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);
      const remaining = await others(f.tt1, removed);
      const bannedAdmin = remaining[remaining.length - 1];
      await setRosterRole(f, f.tt1, bannedAdmin, "Admin");
      const staff = await fx.player();
      await postgres.query(
        "INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id) VALUES ($1, 'ban', $2)",
        [bannedAdmin, staff],
      );

      await removeFromRoster(f, f.tt1, removed);

      expect(await captainOf(f.tt1)).toBe(remaining[0]);
    });

    it("never picks a pending invite", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);
      const remaining = await others(f.tt1, removed);
      await setRosterRole(f, f.tt1, remaining[0], "Invite");

      await removeFromRoster(f, f.tt1, removed);

      expect(await captainOf(f.tt1)).toBe(remaining[1]);
    });

    it("the unstarted match lineup follows the new captain, with exactly one captain and no duplicates", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);

      await removeFromRoster(f, f.tt1, removed);

      const newCaptain = await captainOf(f.tt1);
      const lineup = await seated(f.lineup1);
      expect(lineup.filter((r) => r.captain).map((r) => r.steam_id)).toEqual([
        newCaptain,
      ]);
      expect(lineup.map((r) => r.steam_id)).not.toContain(removed);
      await expectSameSeatsAsRoster(f);
    });

    it("never changes the permanent team captain", async () => {
      const f = await seed(5);
      const removed = await captainOf(f.tt1);
      const before = await permanentCaptain(f.tt1);
      expect(before).toBe(removed);

      await removeFromRoster(f, f.tt1, removed);

      expect(await permanentCaptain(f.tt1)).toBe(before);
      expect(await captainOf(f.tt1)).not.toBe(before);
    });

    it("removing someone who is not the captain leaves the captain alone", async () => {
      const f = await seed(5);
      const captain = await captainOf(f.tt1);
      const victim = (await roster(f.tt1)).find((s) => s !== captain)!;

      await removeFromRoster(f, f.tt1, victim);

      expect(await captainOf(f.tt1)).toBe(captain);
    });

    it.each(["Veto", "WaitingForServer", "Live", "Finished"])(
      "a match that is %s keeps its lineup and captain, while the team captain still moves on",
      async (status) => {
        const f = await seed(5);
        const removed = await captainOf(f.tt1);
        const before = await seated(f.lineup1);

        await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          f.matchId,
          status,
        ]);
        await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");

        await removeFromRoster(f, f.tt1, removed);

        expect(await seated(f.lineup1)).toEqual(before);
        expect(await captainOf(f.tt1)).not.toBe(removed);
      },
    );

    it("does not invent a captain when nobody eligible is left", async () => {
      const organizer = await fx.player();
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
         SELECT 8, 1, 'Competitive', id, false, true, '{TestA}'
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
      await runAsUser(postgres, organizer, "admin", (query) =>
        query(
          "UPDATE tournaments SET status = 'RegistrationOpen' WHERE id = $1",
          [tournament.id],
        ),
      );
      const team = await fx.team(2);
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2`,
          [tournament.id, team.id],
        ),
      );
      const [entry] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_teams WHERE tournament_id = $1",
        [tournament.id],
      );
      const ttId = entry.id;
      const captain = await captainOf(ttId);
      const drop = (steam: string) =>
        runAsUser(postgres, organizer, "admin", (query) =>
          query(
            "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
            [ttId, steam],
          ),
        );
      for (const steam of await roster(ttId)) {
        if (steam !== captain) await drop(steam);
      }
      expect(await roster(ttId)).toEqual([captain]);

      await drop(captain);

      expect(await roster(ttId)).toEqual([]);
      // No one to hand it to: the captain is left as it was, not invented.
      expect(await captainOf(ttId)).toBe(captain);
    });
  });
});
