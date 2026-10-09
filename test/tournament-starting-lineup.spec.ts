import { TournamentRegistrationService } from "../src/tournaments/tournament-registration.service";
import { TournamentRegistrationController } from "../src/tournaments/tournament-registration.controller";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A tournament roster may hold starters and substitutes; a match is played by
// the starting size only. The match lineup is the list of active players: it
// is seeded with a default pick, the team's staff can change it until the
// match starts, and it is never rewritten afterwards. Substitutes stay on the
// tournament roster, so they are not seated, not rated and carry no stats for
// a match they did not start in.
describe("tournament match starting lineup (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentStartingLineup");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199970000000n);
    cups = new TournamentFixtures(postgres, fx);
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

  type Cup = {
    id: string;
    organizer: string;
    matchId: string;
    lineup1: string;
    lineup2: string;
    tt1: string;
    tt2: string;
    team1Owner: string;
  };

  // Four teams of `mates + 1`, a substitute allowance of `subs`, registration
  // closed so round 1 exists and is seated.
  const build = async ({
    type = "Wingman",
    mates = 3,
    subs = 2,
  }: { type?: string; mates?: number; subs?: number } = {}): Promise<Cup> => {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      type,
    );
    if (subs > 0) {
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = $2
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id, subs],
      );
    }
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await cups.registerTeam(t.id, await fx.team(mates));
    }
    await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
    const [b] = await postgres.query<
      Array<{
        match_id: string;
        l1: string;
        l2: string;
        tt1: string;
        tt2: string;
      }>
    >(
      `SELECT tb.match_id, m.lineup_1_id AS l1, m.lineup_2_id AS l2,
              tb.tournament_team_id_1 AS tt1, tb.tournament_team_id_2 AS tt2
         FROM tournament_brackets tb
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = $1 AND tb.match_id IS NOT NULL
        ORDER BY tb.round, tb.match_number LIMIT 1`,
      [t.id],
    );
    const [owner] = await postgres.query<Array<{ owner_steam_id: string }>>(
      "SELECT owner_steam_id::text FROM tournament_teams WHERE id = $1",
      [b.tt1],
    );
    return {
      id: t.id,
      organizer: t.organizer,
      matchId: b.match_id,
      lineup1: b.l1,
      lineup2: b.l2,
      tt1: b.tt1,
      tt2: b.tt2,
      team1Owner: owner.owner_steam_id,
    };
  };

  const seats = async (lineupId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      )
    ).map((r) => r.steam_id);

  const roster = async (ttId: string) =>
    postgres.query<Array<{ steam_id: string; role: string }>>(
      "SELECT player_steam_id::text AS steam_id, role FROM tournament_team_roster WHERE tournament_team_id = $1 ORDER BY player_steam_id",
      [ttId],
    );

  const captainOf = async (ttId: string) => {
    const [r] = await postgres.query<Array<{ captain_steam_id: string }>>(
      "SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1",
      [ttId],
    );
    return r.captain_steam_id;
  };

  const session = (steamId: string, role = "user") =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

  const choose = (
    c: Cup,
    lineup: string,
    steamIds: string[],
    steamId = c.organizer,
    role = "administrator",
  ) =>
    postgres.query(
      "SELECT set_match_starting_lineup($1, $2, $3::bigint[], $4::json)",
      [c.matchId, lineup, steamIds, session(steamId, role)],
    );

  const rated = async (matchId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM player_elo WHERE match_id = $1 ORDER BY steam_id",
        [matchId],
      )
    ).map((r) => r.steam_id);

  // Ends the match with lineup 1 as the winner, without any recorded play,
  // and rates it.
  const freeWin = async (c: Cup, status?: string) => {
    if (status) {
      await postgres.query(
        "UPDATE matches SET status = $2, winning_lineup_id = lineup_1_id WHERE id = $1",
        [c.matchId, status],
      );
    } else {
      await cups.winMatch(c.matchId);
    }
    await postgres.query(
      "UPDATE matches SET ended_at = now() - interval '1 hour' WHERE id = $1",
      [c.matchId],
    );
    await postgres.query("SELECT generate_player_elo_for_match($1)", [
      c.matchId,
    ]);
    return rated(c.matchId);
  };

  const isReady = async (lineupId: string) => {
    const [r] = await postgres.query<Array<{ ready: boolean }>>(
      "SELECT is_match_lineup_ready(ml) AS ready FROM match_lineups ml WHERE ml.id = $1",
      [lineupId],
    );
    return r.ready;
  };

  describe("seating", () => {
    it("a 2v2 roster of four seats exactly two; the other two stay on the roster", async () => {
      const c = await build();
      expect((await roster(c.tt1)).length).toBe(4);
      expect(await seats(c.lineup1)).toHaveLength(2);
      expect(await seats(c.lineup2)).toHaveLength(2);
      for (const steam of await seats(c.lineup1)) {
        expect((await roster(c.tt1)).map((r) => r.steam_id)).toContain(steam);
      }
    });

    it("a 5v5 roster of seven seats exactly five", async () => {
      const c = await build({ type: "Competitive", mates: 6, subs: 2 });
      expect((await roster(c.tt1)).length).toBe(7);
      expect(await seats(c.lineup1)).toHaveLength(5);
      expect(await seats(c.lineup2)).toHaveLength(5);
    });

    it("a roster of exactly the starting size seats everyone with nothing to choose", async () => {
      const c = await build({ mates: 1 });
      expect(await seats(c.lineup1)).toEqual(
        (await roster(c.tt1)).map((r) => r.steam_id),
      );
      expect(await isReady(c.lineup1)).toBe(false); // nobody checked in yet
      await postgres.query(
        "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
        [c.lineup1],
      );
      expect(await isReady(c.lineup1)).toBe(true);
    });

    it("the default pick puts the captain first", async () => {
      const c = await build();
      expect(await seats(c.lineup1)).toContain(await captainOf(c.tt1));
    });
  });

  describe("choosing the active players", () => {
    it("requires exactly the starting size (2 in Wingman)", async () => {
      const c = await build();
      const rostered = (await roster(c.tt1)).map((r) => r.steam_id);
      const captain = await captainOf(c.tt1);
      await expect(choose(c, c.lineup1, [captain])).rejects.toThrow(
        /exactly 2 players/i,
      );
      await expect(
        choose(c, c.lineup1, rostered.slice(0, 3)),
      ).rejects.toThrow(/exactly 2 players/i);
      await expect(choose(c, c.lineup1, [captain, captain])).rejects.toThrow(
        /exactly 2 players/i,
      );
      await expect(choose(c, c.lineup1, [])).rejects.toThrow(
        /exactly 2 players/i,
      );
    });

    it("requires exactly the starting size (5 in Competitive)", async () => {
      const c = await build({ type: "Competitive", mates: 6, subs: 2 });
      const rostered = (await roster(c.tt1)).map((r) => r.steam_id);
      const captain = await captainOf(c.tt1);
      const others = rostered.filter((s) => s !== captain);
      await expect(
        choose(c, c.lineup1, [captain, ...others.slice(0, 3)]),
      ).rejects.toThrow(/exactly 5 players/i);
      await expect(
        choose(c, c.lineup1, [captain, ...others.slice(0, 5)]),
      ).rejects.toThrow(/exactly 5 players/i);

      await choose(c, c.lineup1, [captain, ...others.slice(2, 6)]);
      const lineup = await seats(c.lineup1);
      expect(lineup).toHaveLength(5);
      expect(lineup.sort()).toEqual([captain, ...others.slice(2, 6)].sort());
    });

    it("only players on the tournament roster can be chosen", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const stranger = await fx.player();
      await expect(
        choose(c, c.lineup1, [captain, stranger]),
      ).rejects.toThrow(/tournament roster/i);
      const opponent = (await roster(c.tt2))[0].steam_id;
      await expect(
        choose(c, c.lineup1, [captain, opponent]),
      ).rejects.toThrow(/tournament roster/i);
    });

    it("the tournament captain may sit the match out and still manage the lineup", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain);

      // The captain benches themselves.
      await choose(c, c.lineup1, others.slice(0, 2), captain, "user");

      const rows = await postgres.query<Array<{ steam_id: string; captain: boolean }>>(
        "SELECT steam_id::text, captain FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [c.lineup1],
      );
      expect(rows.map((r) => r.steam_id).sort()).toEqual(others.slice(0, 2).sort());
      // Exactly one seated match captain, who is not the benched tournament captain.
      expect(rows.filter((r) => r.captain)).toHaveLength(1);
      expect(rows.some((r) => r.steam_id === captain)).toBe(false);
      const [tt] = await postgres.query<Array<{ captain_steam_id: string }>>(
        "SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1",
        [c.tt1],
      );
      expect(tt.captain_steam_id).toBe(captain);

      // The benched captain can still change the lineup afterwards.
      await choose(c, c.lineup1, [captain, others[2]], captain, "user");
      expect((await seats(c.lineup1)).sort()).toEqual([captain, others[2]].sort());
    });

    it("a substitute can be swapped in before the match; a changed seat loses its check-in, the rest keep theirs", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const before = await seats(c.lineup1);
      const kept = before.find((s) => s !== captain)!;
      const bench = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => !before.includes(s));
      expect(bench).toHaveLength(2);
      await postgres.query(
        "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
        [c.lineup1],
      );

      await choose(c, c.lineup1, [captain, bench[0]]);

      const rows = await postgres.query<
        Array<{ steam_id: string; checked_in: boolean; captain: boolean }>
      >(
        "SELECT steam_id::text, checked_in, captain FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [c.lineup1],
      );
      expect(rows.map((r) => r.steam_id).sort()).toEqual(
        [captain, bench[0]].sort(),
      );
      expect(rows.find((r) => r.steam_id === bench[0])?.checked_in).toBe(false);
      expect(rows.find((r) => r.steam_id === captain)?.checked_in).toBe(true);
      expect(rows.filter((r) => r.captain).map((r) => r.steam_id)).toEqual([
        captain,
      ]);
      expect(await seats(c.lineup1)).not.toContain(kept);
    });

    it("can be changed again, and back, any number of times before the lock", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain);
      for (const pick of [others[0], others[1], others[2], others[0]]) {
        await choose(c, c.lineup1, [captain, pick]);
        expect((await seats(c.lineup1)).sort()).toEqual([captain, pick].sort());
      }
    });

    it("only the lineups of the team being chosen for change", async () => {
      const c = await build();
      const other = await seats(c.lineup2);
      const captain = await captainOf(c.tt1);
      const bench = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain)[2];
      await choose(c, c.lineup1, [captain, bench]);
      expect(await seats(c.lineup2)).toEqual(other);
    });

    it("a lineup that is not part of the match is refused", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      await expect(
        postgres.query(
          "SELECT set_match_starting_lineup($1, $2, $3::bigint[], $4::json)",
          [
            c.matchId,
            "00000000-0000-4000-8000-000000000000",
            [captain],
            session(c.organizer, "administrator"),
          ],
        ),
      ).rejects.toThrow(/not part of this match/i);
    });
  });

  describe("who may choose", () => {
    const sub = async (c: Cup) => {
      const captain = await captainOf(c.tt1);
      const seated = await seats(c.lineup1);
      const bench = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .find((s) => !seated.includes(s))!;
      return { captain, pick: [captain, bench] };
    };

    it("the tournament captain may", async () => {
      const c = await build();
      const { captain, pick } = await sub(c);
      await choose(c, c.lineup1, pick, captain, "user");
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());
    });

    it("the team owner may", async () => {
      const c = await build();
      const { pick } = await sub(c);
      await choose(c, c.lineup1, pick, c.team1Owner, "user");
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());
    });

    it("a tournament team Admin may", async () => {
      const c = await build();
      const { captain, pick } = await sub(c);
      const admin = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .find((s) => s !== captain && s !== c.team1Owner)!;
      await postgres.query(
        "UPDATE tournament_team_roster SET role = 'Admin' WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, admin],
      );
      await choose(c, c.lineup1, pick, admin, "user");
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());
    });

    it("the tournament organizer, a co-organizer and a site administrator may", async () => {
      const c = await build();
      const { pick } = await sub(c);
      const co = await fx.player();
      await postgres.query(
        "INSERT INTO tournament_organizers (steam_id, tournament_id) VALUES ($1, $2)",
        [co, c.id],
      );
      const admin = await fx.player();

      await choose(c, c.lineup1, pick, c.organizer, "tournament_organizer");
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());

      const captain = await captainOf(c.tt1);
      const other = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain)[2];
      await choose(c, c.lineup1, [captain, other], co, "tournament_organizer");
      expect((await seats(c.lineup1)).sort()).toEqual(
        [captain, other].sort(),
      );

      await choose(c, c.lineup1, pick, admin, "administrator");
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());
    });

    it("an ordinary member of the team may not", async () => {
      const c = await build();
      const { captain, pick } = await sub(c);
      const member = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .find((s) => s !== captain && s !== c.team1Owner)!;
      const before = await seats(c.lineup1);
      await expect(
        choose(c, c.lineup1, pick, member, "user"),
      ).rejects.toThrow(/cannot choose the starting lineup/i);
      expect(await seats(c.lineup1)).toEqual(before);
    });

    it("another team's captain or an outsider may not", async () => {
      const c = await build();
      const { pick } = await sub(c);
      const rivalCaptain = await captainOf(c.tt2);
      const outsider = await fx.player();
      await expect(
        choose(c, c.lineup1, pick, rivalCaptain, "user"),
      ).rejects.toThrow(/cannot choose the starting lineup/i);
      await expect(
        choose(c, c.lineup1, pick, outsider, "user"),
      ).rejects.toThrow(/cannot choose the starting lineup/i);
    });

    it("the Hasura action runs the same check as the caller", async () => {
      const c = await build();
      const { captain, pick } = await sub(c);
      const controller = new TournamentRegistrationController(
        { log: jest.fn() } as any,
        postgres,
        { notifyPlayers: jest.fn() } as any,
        { getConnection: () => ({}) } as any,
        { assertAccepted: jest.fn() } as any,
        new TournamentRegistrationService(postgres),
      );
      const member = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .find((s) => s !== captain && s !== c.team1Owner)!;
      await expect(
        controller.setMatchStartingLineup({
          user: { steam_id: member, role: "user" } as any,
          match_id: c.matchId,
          match_lineup_id: c.lineup1,
          steam_ids: pick,
        }),
      ).rejects.toThrow(/cannot choose the starting lineup/i);
      await expect(
        controller.setMatchStartingLineup({
          user: { steam_id: captain, role: "user" } as any,
          match_id: c.matchId,
          match_lineup_id: c.lineup1,
          steam_ids: pick,
        }),
      ).resolves.toEqual({ success: true });
      expect((await seats(c.lineup1)).sort()).toEqual([...pick].sort());
    });
  });

  describe("ready and check-in", () => {
    // A match created before starting lineups existed seats the whole roster.
    const seatEveryone = async (c: Cup) => {
      for (const { steam_id } of await roster(c.tt1)) {
        await postgres.query(
          `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
           SELECT $1, $2 WHERE NOT EXISTS (
             SELECT 1 FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2
           )`,
          [c.lineup1, steam_id],
        );
      }
    };

    it.each(["Captains", "Players"])(
      "a lineup that still seats more than the starting size cannot be ready (%s)",
      async (setting) => {
        const c = await build();
        await postgres.query(
          `UPDATE match_options SET check_in_setting = $2
            WHERE id = (SELECT match_options_id FROM matches WHERE id = $1)`,
          [c.matchId, setting],
        );
        await seatEveryone(c);
        expect(await seats(c.lineup1)).toHaveLength(4);
        await postgres.query(
          "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
          [c.lineup1],
        );
        expect(await isReady(c.lineup1)).toBe(false);

        const captain = await captainOf(c.tt1);
        const other = (await roster(c.tt1))
          .map((r) => r.steam_id)
          .find((s) => s !== captain)!;
        await choose(c, c.lineup1, [captain, other]);
        await postgres.query(
          "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
          [c.lineup1],
        );
        expect(await isReady(c.lineup1)).toBe(true);
      },
    );

    it("choosing for a lineup that seats too many trims it to the chosen players", async () => {
      const c = await build();
      await seatEveryone(c);
      const captain = await captainOf(c.tt1);
      const other = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain)[1];
      await choose(c, c.lineup1, [captain, other]);
      expect((await seats(c.lineup1)).sort()).toEqual([captain, other].sort());
    });
  });

  describe("confirming the starting lineup", () => {
    const needs = async (lineupId: string) => {
      const [r] = await postgres.query<Array<{ needs: boolean }>>(
        "SELECT match_lineup_needs_starting_lineup_confirmation(ml) AS needs FROM match_lineups ml WHERE ml.id = $1",
        [lineupId],
      );
      return r.needs;
    };
    const checkInAll = (lineupId: string) =>
      postgres.query(
        "UPDATE match_lineup_players SET checked_in = true WHERE match_lineup_id = $1",
        [lineupId],
      );
    const setting = (matchId: string, value: string) =>
      postgres.query(
        "UPDATE match_options SET check_in_setting = $2 WHERE id = (SELECT match_options_id FROM matches WHERE id = $1)",
        [matchId, value],
      );

    it.each([
      ["Wingman", 1, 0],
      ["Competitive", 4, 0],
    ])("a %s roster of exactly the starting size needs no confirmation", async (type, mates, subs) => {
      const c = await build({ type, mates, subs });
      expect(await needs(c.lineup1)).toBe(false);
      await checkInAll(c.lineup1);
      expect(await isReady(c.lineup1)).toBe(true);
    });

    it.each([
      ["Wingman", 2, 2],
      ["Wingman", 3, 2],
      ["Competitive", 5, 2],
      ["Competitive", 6, 2],
    ])("a %s roster with substitutes (%i mates) is not ready until confirmed", async (type, mates, subs) => {
      const c = await build({ type, mates, subs });
      expect(await needs(c.lineup1)).toBe(true);
      await checkInAll(c.lineup1);
      // Everyone seated has checked in, and still the default is not enough.
      expect(await isReady(c.lineup1)).toBe(false);
      await setting(c.matchId, "Captains");
      expect(await isReady(c.lineup1)).toBe(false);

      // Confirming exactly the default lineup is enough.
      await choose(c, c.lineup1, await seats(c.lineup1));
      expect(await needs(c.lineup1)).toBe(false);
      await checkInAll(c.lineup1);
      expect(await isReady(c.lineup1)).toBe(true);
    });

    it("cannot be confirmed with the wrong number of players", async () => {
      const c = await build({ type: "Competitive", mates: 6, subs: 2 });
      const seated = await seats(c.lineup1);
      await expect(choose(c, c.lineup1, seated.slice(0, 4))).rejects.toThrow(/exactly 5/i);
      expect(await needs(c.lineup1)).toBe(true);
    });

    it("nobody on an unconfirmed lineup can check in, then they can", async () => {
      const c = await build();
      const [lineupPlayer] = await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM match_lineup_players WHERE match_lineup_id = $1 LIMIT 1",
        [c.lineup1],
      );
      const can = async () => {
        const [r] = await postgres.query<Array<{ ok: boolean }>>(
          "SELECT can_check_in(m, $2::json) AS ok FROM matches m WHERE m.id = $1",
          [c.matchId, session(lineupPlayer.steam_id)],
        );
        return r.ok;
      };
      await setting(c.matchId, "Players");
      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query("UPDATE matches SET status = 'WaitingForCheckIn' WHERE id = $1", [c.matchId]);
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");
      expect(await can()).toBe(false);
      await choose(c, c.lineup1, await seats(c.lineup1));
      expect(await can()).toBe(true);
    });

    it("changing a confirmed lineup before the lock works and keeps it confirmed", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1)).map((r) => r.steam_id).filter((s) => s !== captain);
      await choose(c, c.lineup1, [captain, others[0]]);
      await choose(c, c.lineup1, [captain, others[2]]);
      expect(await needs(c.lineup1)).toBe(false);
      expect((await seats(c.lineup1)).sort()).toEqual([captain, others[2]].sort());
    });

    it("a substitute leaving the roster keeps the confirmation", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1)).map((r) => r.steam_id).filter((s) => s !== captain);
      await choose(c, c.lineup1, [captain, others[0]]);
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, others[2]],
      );
      expect(await needs(c.lineup1)).toBe(false);
      expect((await seats(c.lineup1)).sort()).toEqual([captain, others[0]].sort());
    });

    it("a confirmed player leaving the roster moves the seat and asks for a new confirmation", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1)).map((r) => r.steam_id).filter((s) => s !== captain);
      await choose(c, c.lineup1, [captain, others[0]]);
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, others[0]],
      );
      expect(await seats(c.lineup1)).toHaveLength(2);
      expect(await seats(c.lineup1)).not.toContain(others[0]);
      expect((await roster(c.tt1)).length).toBe(3);
      expect(await needs(c.lineup1)).toBe(true);
    });

    it("a confirmed lineup is the one a free win rates", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const bench = (await roster(c.tt1)).map((r) => r.steam_id).filter((s) => s !== captain);
      const pick = [captain, bench[2]];
      await choose(c, c.lineup1, pick);
      await choose(c, c.lineup2, await seats(c.lineup2));

      const ratedPlayers = await freeWin(c);

      for (const p of pick) expect(ratedPlayers).toContain(p);
      expect(ratedPlayers).toHaveLength(4);
      const unused = (await roster(c.tt1)).map((r) => r.steam_id).filter((x) => !pick.includes(x));
      for (const x of unused) expect(ratedPlayers).not.toContain(x);
    });

    it("a started match cannot be confirmed or changed", async () => {
      const c = await build();
      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [c.matchId]);
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");
      await expect(choose(c, c.lineup1, await seats(c.lineup1))).rejects.toThrow(/locked/i);
      expect(await needs(c.lineup1)).toBe(true);
    });
  });

  describe("locked once the match has started", () => {
    it.each(["Veto", "WaitingForServer", "Live", "Finished", "Canceled"])(
      "a %s match keeps its lineup",
      async (status) => {
        const c = await build();
        const before = await seats(c.lineup1);
        const captain = await captainOf(c.tt1);
        const bench = (await roster(c.tt1))
          .map((r) => r.steam_id)
          .find((s) => !before.includes(s))!;
        await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          c.matchId,
          status,
        ]);
        await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");

        await expect(
          choose(c, c.lineup1, [captain, bench]),
        ).rejects.toThrow(/locked once the match has started/i);
        expect(await seats(c.lineup1)).toEqual(before);
      },
    );

    it("a roster change after the match started does not rewrite the lineup that played", async () => {
      const c = await build();
      const before = await seats(c.lineup1);
      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query(
        "UPDATE matches SET status = 'Live' WHERE id = $1",
        [c.matchId],
      );
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");

      const captain = await captainOf(c.tt1);
      const victim = before.find((s) => s !== captain)!;
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, victim],
      );

      expect(await seats(c.lineup1)).toEqual(before);
    });

    it("a roster change before the start keeps the chosen lineup and only refills a vacated seat", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const others = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .filter((s) => s !== captain);
      await choose(c, c.lineup1, [captain, others[2]]);

      // A player who is not in the lineup leaves: nothing changes.
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, others[0]],
      );
      expect((await seats(c.lineup1)).sort()).toEqual(
        [captain, others[2]].sort(),
      );

      // A chosen player leaves: the seat is refilled from the roster.
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [c.tt1, others[2]],
      );
      const after = await seats(c.lineup1);
      expect(after).toHaveLength(2);
      expect(after).toContain(captain);
      expect(after).not.toContain(others[2]);
    });
  });

  describe("ELO", () => {
    it("a free win rates only the two selected players of four, never the unused substitutes", async () => {
      const c = await build();
      const seated = await seats(c.lineup1);
      const roster1 = (await roster(c.tt1)).map((r) => r.steam_id);
      const unused = roster1.filter((s) => !seated.includes(s));
      expect(unused).toHaveLength(2);

      const ratedPlayers = await freeWin(c);

      expect(new Set(ratedPlayers)).toEqual(
        new Set([...seated, ...(await seats(c.lineup2))]),
      );
      for (const s of unused) expect(ratedPlayers).not.toContain(s);
      expect(ratedPlayers).toHaveLength(4);
    });

    it("a substitute who was selected gets the rating, the benched starter does not", async () => {
      const c = await build();
      const captain = await captainOf(c.tt1);
      const before = await seats(c.lineup1);
      const dropped = before.find((s) => s !== captain)!;
      const bench = (await roster(c.tt1))
        .map((r) => r.steam_id)
        .find((s) => !before.includes(s))!;
      await choose(c, c.lineup1, [captain, bench]);

      const ratedPlayers = await freeWin(c);

      expect(ratedPlayers).toContain(bench);
      expect(ratedPlayers).toContain(captain);
      expect(ratedPlayers).not.toContain(dropped);
    });

    it.each(["Forfeit", "Surrendered"])(
      "a %s result rates the active lineup only",
      async (status) => {
        const c = await build();
        const seated = await seats(c.lineup1);
        const unused = (await roster(c.tt1))
          .map((r) => r.steam_id)
          .filter((s) => !seated.includes(s));

        const ratedPlayers = await freeWin(c, status);

        expect(ratedPlayers.sort()).toEqual(
          [...seated, ...(await seats(c.lineup2))].sort(),
        );
        for (const s of unused) expect(ratedPlayers).not.toContain(s);
      },
    );

    it("a normal exact-size 2v2 and 5v5 are rated exactly as before", async () => {
      const wingman = await build({ mates: 1, subs: 0 });
      expect(await freeWin(wingman)).toHaveLength(4);

      const competitive = await build({ type: "Competitive", mates: 4, subs: 0 });
      expect(await freeWin(competitive)).toHaveLength(10);
    });

    it("an active player who abandoned still takes the leaver penalty", async () => {
      const c = await build();
      const seated = await seats(c.lineup1);
      await postgres.query(
        "UPDATE match_lineup_players SET elo_penalty = true WHERE match_lineup_id = $1 AND steam_id = $2",
        [c.lineup1, seated[0]],
      );

      const ratedPlayers = await freeWin(c);
      expect(ratedPlayers).toContain(seated[0]);
      const [row] = await postgres.query<Array<{ change: number }>>(
        "SELECT change FROM player_elo WHERE match_id = $1 AND steam_id = $2",
        [c.matchId, seated[0]],
      );
      expect(Number(row.change)).toBe(-250);
    });

    it("a tournament lineup that still seats substitutes and has no activity is rated over its default starters only", async () => {
      const c = await build();
      for (const { steam_id } of await roster(c.tt1)) {
        await postgres.query(
          `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
           SELECT $1, $2 WHERE NOT EXISTS (
             SELECT 1 FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2
           )`,
          [c.lineup1, steam_id],
        );
      }
      expect(await seats(c.lineup1)).toHaveLength(4);
      const captain = await captainOf(c.tt1);

      const ratedPlayers = await freeWin(c);

      const winners = (await seats(c.lineup1)).filter((s) =>
        ratedPlayers.includes(s),
      );
      expect(winners).toHaveLength(2);
      expect(winners).toContain(captain);
    });

    it("a non-tournament match with substitutes and no activity is rated as before", async () => {
      const players = await fx.players(6);
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
         SELECT 8, 1, 'Wingman', id, false, true, '{TestA}', 2
         FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      );
      const [m] = await postgres.query<
        Array<{ id: string; lineup_1_id: string; lineup_2_id: string }>
      >(
        `INSERT INTO matches (status, organizer_steam_id, match_options_id)
         VALUES ('PickingPlayers', $1, $2) RETURNING id, lineup_1_id, lineup_2_id`,
        [players[0], options.id],
      );
      for (const [i, p] of players.entries()) {
        await postgres.query(
          "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
          [i < 3 ? m.lineup_1_id : m.lineup_2_id, p],
        );
      }
      await postgres.query(
        "UPDATE matches SET winning_lineup_id = lineup_1_id, status = 'Finished', ended_at = now() - interval '1 hour' WHERE id = $1",
        [m.id],
      );
      await postgres.query("SELECT generate_player_elo_for_match($1)", [m.id]);

      expect(await rated(m.id)).toHaveLength(6);
    });
  });
});
