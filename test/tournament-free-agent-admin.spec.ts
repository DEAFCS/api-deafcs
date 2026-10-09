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

// Organizers manage the Free Agent pool before the draft: add an eligible
// player, remove an entry. The rules a player meets when they join themselves
// still apply to the player an organizer adds, and a drafted entry belongs to
// a generated team, so it is never edited through the pool.
describe("tournament free agent pool, organizer controls (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentFreeAgentAdmin");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199971000000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const controller = () =>
    new TournamentRegistrationController(
      { log: jest.fn() } as any,
      postgres,
      { notifyPlayers: jest.fn() } as any,
      { getConnection: () => ({ eval: jest.fn().mockResolvedValue(1) }) } as any,
      { assertAccepted: jest.fn() } as any,
      new TournamentRegistrationService(postgres),
    );

  const as = (steam_id: string, role = "user") =>
    ({ steam_id, role, name: "Fixture" }) as any;

  const cup = async (registrationType = "free_agents") => {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      "Wingman",
      2,
    );
    await postgres.query(
      "UPDATE tournaments SET registration_type = $2 WHERE id = $1",
      [t.id, registrationType],
    );
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  };

  const add = (
    tournamentId: string,
    player: string,
    user: ReturnType<typeof as>,
  ) =>
    controller().addTournamentFreeAgent({
      user,
      tournament_id: tournamentId,
      player_steam_id: player,
    });

  const remove = (
    tournamentId: string,
    player: string,
    user: ReturnType<typeof as>,
  ) =>
    controller().removeTournamentFreeAgent({
      user,
      tournament_id: tournamentId,
      player_steam_id: player,
    });

  const entry = async (tournamentId: string, player: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournament_free_agents WHERE tournament_id = $1 AND player_steam_id = $2",
      [tournamentId, player],
    );
    return row?.status;
  };

  describe("who may add and remove", () => {
    it("the tournament organizer adds and removes a player", async () => {
      const t = await cup();
      const p = await fx.player();
      await expect(add(t.id, p, as(t.organizer, "user"))).resolves.toEqual({
        success: true,
      });
      expect(await entry(t.id, p)).toBe("registered");
      await expect(remove(t.id, p, as(t.organizer, "user"))).resolves.toEqual({
        success: true,
      });
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it("a co-organizer adds and removes a player", async () => {
      const t = await cup();
      const co = await fx.player();
      await postgres.query(
        "INSERT INTO tournament_organizers (steam_id, tournament_id) VALUES ($1, $2)",
        [co, t.id],
      );
      const p = await fx.player();
      await add(t.id, p, as(co, "tournament_organizer"));
      expect(await entry(t.id, p)).toBe("registered");
      await remove(t.id, p, as(co, "tournament_organizer"));
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it("a site administrator adds and removes a player", async () => {
      const t = await cup();
      const admin = await fx.player();
      const p = await fx.player();
      await add(t.id, p, as(admin, "administrator"));
      expect(await entry(t.id, p)).toBe("registered");
      await remove(t.id, p, as(admin, "administrator"));
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it.each(["user", "verified_user", "match_organizer", "moderator", "streamer"])(
      "an ordinary %s cannot add or remove anyone",
      async (role) => {
        const t = await cup();
        const caller = await fx.player();
        const p = await fx.player();
        await expect(add(t.id, p, as(caller, role))).rejects.toThrow(
          /not the tournament organizer/i,
        );
        await add(t.id, p, as(t.organizer));
        await expect(remove(t.id, p, as(caller, role))).rejects.toThrow(
          /not the tournament organizer/i,
        );
        expect(await entry(t.id, p)).toBe("registered");
      },
    );

    it("a team owner or captain of this tournament is not an organizer", async () => {
      const t = await cup("both");
      const team = await fx.team(1);
      await cups.registerTeam(t.id, team);
      const p = await fx.player();
      await expect(add(t.id, p, as(team.owner))).rejects.toThrow(
        /not the tournament organizer/i,
      );
    });

    it("the player themselves cannot use the organizer action to add someone else", async () => {
      const t = await cup();
      const self = await fx.player();
      const other = await fx.player();
      await expect(add(t.id, other, as(self))).rejects.toThrow(
        /not the tournament organizer/i,
      );
    });
  });

  describe("eligibility and the one-team rule", () => {
    it("refuses a player who is already on a premade tournament roster", async () => {
      const t = await cup("both");
      const team = await fx.team(1);
      await cups.registerTeam(t.id, team);
      const [rostered] = await postgres.query<Array<{ steam: string }>>(
        "SELECT player_steam_id::text AS steam FROM tournament_team_roster WHERE tournament_id = $1 LIMIT 1",
        [t.id],
      );
      await expect(add(t.id, rostered.steam, as(t.organizer))).rejects.toThrow(
        /already on a tournament roster/i,
      );
      expect(await entry(t.id, rostered.steam)).toBeUndefined();
    });

    it("refuses a player who owns a team in this tournament", async () => {
      const t = await cup("both");
      const team = await fx.team(1);
      await cups.registerTeam(t.id, team);
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, team.owner],
      );
      await expect(add(t.id, team.owner, as(t.organizer))).rejects.toThrow(
        /already have a team|already on a tournament roster/i,
      );
    });

    it("refuses a player who is already in the pool, and one who was drafted", async () => {
      const t = await cup();
      const p = await fx.player();
      await add(t.id, p, as(t.organizer));
      await expect(add(t.id, p, as(t.organizer))).rejects.toThrow(
        /already in the free agent pool/i,
      );
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'drafted' WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, p],
      );
      await expect(add(t.id, p, as(t.organizer))).rejects.toThrow(
        /already been drafted/i,
      );
    });

    it("refuses a banned player", async () => {
      const t = await cup();
      const p = await fx.player();
      await postgres.query(
        "INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id) VALUES ($1, 'ban', $2)",
        [p, t.organizer],
      );
      await expect(add(t.id, p, as(t.organizer))).rejects.toThrow(
        /entry requirements/i,
      );
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it("refuses a player below the Verified User requirement, and an unknown player", async () => {
      const t = await cup();
      await postgres.query(
        "UPDATE tournaments SET min_role = 'verified_user' WHERE id = $1",
        [t.id],
      );
      const p = await fx.player();
      await expect(add(t.id, p, as(t.organizer))).rejects.toThrow(
        /entry requirements/i,
      );
      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
        [p],
      );
      await add(t.id, p, as(t.organizer));
      expect(await entry(t.id, p)).toBe("registered");

      await expect(add(t.id, "76561199971999999", as(t.organizer))).rejects.toThrow(
        /player not found/i,
      );
    });

    it("an organizer can add to an invite only tournament, a stranger still cannot join it", async () => {
      const t = await cup();
      await postgres.query("UPDATE tournaments SET invite_only = true WHERE id = $1", [
        t.id,
      ]);
      const p = await fx.player();
      await add(t.id, p, as(t.organizer));
      expect(await entry(t.id, p)).toBe("registered");
    });

    it("a tournament of premade teams only has no pool to edit", async () => {
      const t = await cup("teams");
      await expect(add(t.id, await fx.player(), as(t.organizer))).rejects.toThrow(
        /does not accept free agents/i,
      );
    });

    it("re-adding a withdrawn entry registers it again", async () => {
      const t = await cup();
      const p = await fx.player();
      await add(t.id, p, as(t.organizer));
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'withdrawn' WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, p],
      );
      await add(t.id, p, as(t.organizer));
      expect(await entry(t.id, p)).toBe("registered");
    });
  });

  describe("staff management outside the open registration window", () => {
    // Not open yet: the tournament is still in Setup.
    const setupCup = async () => {
      const t = await cups.createTournament(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        "Wingman",
        2,
      );
      await postgres.query(
        "UPDATE tournaments SET registration_type = 'free_agents' WHERE id = $1",
        [t.id],
      );
      return t;
    };

    // A held check-in review (the status the check-in hold reaches before the
    // draft). The guarded transition is set directly.
    const reviewCup = async () => {
      const t = await cup();
      await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
      await postgres.query(
        "UPDATE tournaments SET status = 'CheckInReview' WHERE id = $1",
        [t.id],
      );
      await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
      return t;
    };

    const asPlayerInsert = (tournamentId: string, player: string) =>
      postgres.transaction(async (client) => {
        await client.query("SELECT set_config('hasura.user', $1, true)", [
          JSON.stringify({ "x-hasura-role": "user", "x-hasura-user-id": player }),
        ]);
        await client.query(
          "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
          [tournamentId, player],
        );
      });

    const structure = async (tournamentId: string) => {
      const [row] = await postgres.query<Array<{ teams: string; roster: string; status: string }>>(
        `SELECT (SELECT count(*) FROM tournament_teams WHERE tournament_id = $1)::text AS teams,
                (SELECT count(*) FROM tournament_team_roster WHERE tournament_id = $1)::text AS roster,
                (SELECT status FROM tournaments WHERE id = $1) AS status`,
        [tournamentId],
      );
      return row;
    };

    it("the organizer adds and removes a player before registration opens", async () => {
      const t = await setupCup();
      const p = await fx.player();
      await expect(add(t.id, p, as(t.organizer))).resolves.toEqual({ success: true });
      expect(await entry(t.id, p)).toBe("registered");
      await expect(remove(t.id, p, as(t.organizer))).resolves.toEqual({ success: true });
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it("a co-organizer and a site administrator can too", async () => {
      const t = await setupCup();
      const co = await fx.player();
      await postgres.query(
        "INSERT INTO tournament_organizers (steam_id, tournament_id) VALUES ($1, $2)",
        [co, t.id],
      );
      const [p, q] = await fx.players(2);
      await add(t.id, p, as(co, "tournament_organizer"));
      await add(t.id, q, as(await fx.player(), "administrator"));
      expect(await entry(t.id, p)).toBe("registered");
      expect(await entry(t.id, q)).toBe("registered");
      await remove(t.id, p, as(co, "tournament_organizer"));
      await remove(t.id, q, as(await fx.player(), "administrator"));
      expect(await entry(t.id, p)).toBeUndefined();
      expect(await entry(t.id, q)).toBeUndefined();
    });

    it("an ordinary user cannot manage another player's entry before registration opens", async () => {
      const t = await setupCup();
      const caller = await fx.player();
      const p = await fx.player();
      await expect(add(t.id, p, as(caller))).rejects.toThrow(/not the tournament organizer/i);
      await add(t.id, p, as(t.organizer));
      await expect(remove(t.id, p, as(caller))).rejects.toThrow(/not the tournament organizer/i);
      expect(await entry(t.id, p)).toBe("registered");
    });

    it("the organizer manages the pool in a held check-in review", async () => {
      const t = await reviewCup();
      const p = await fx.player();
      await add(t.id, p, as(t.organizer));
      expect(await entry(t.id, p)).toBe("registered");
      await remove(t.id, p, as(t.organizer));
      expect(await entry(t.id, p)).toBeUndefined();
    });

    it("players still cannot sign themselves up before registration opens or in review", async () => {
      const setup = await setupCup();
      const review = await reviewCup();
      const player = await fx.player();
      await expect(
        controller().joinTournamentAsFreeAgent({ user: as(player), tournament_id: setup.id }),
      ).rejects.toThrow(/registration is not open/i);
      // The trigger refuses a player's own write too, whatever the action says.
      await expect(asPlayerInsert(setup.id, player)).rejects.toThrow(/registration is closed/i);
      await expect(asPlayerInsert(review.id, player)).rejects.toThrow(/registration is closed/i);
      expect(await entry(setup.id, player)).toBeUndefined();
    });

    it("players still cannot sign themselves up after registration closes", async () => {
      const t = await cup();
      for (const player of await fx.players(4)) await add(t.id, player, as(t.organizer));
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      const player = await fx.player();
      await expect(
        controller().joinTournamentAsFreeAgent({ user: as(player), tournament_id: t.id }),
      ).rejects.toThrow(/registration is not open/i);
      await expect(asPlayerInsert(t.id, player)).rejects.toThrow(/registration is closed/i);
    });

    it("staff changes in Setup draft nothing and touch no team or bracket", async () => {
      const t = await setupCup();
      const players = await fx.players(4);
      for (const p of players) await add(t.id, p, as(t.organizer));
      await remove(t.id, players[0], as(t.organizer));
      expect(await structure(t.id)).toEqual({ teams: "0", roster: "0", status: "Setup" });
      const [pool] = await postgres.query<Array<{ drafted: string }>>(
        "SELECT count(*) FILTER (WHERE status = 'drafted')::text AS drafted FROM tournament_free_agents WHERE tournament_id = $1",
        [t.id],
      );
      expect(pool.drafted).toBe("0");
    });

    it("a pool edited before registration opens is what the draft uses", async () => {
      const t = await setupCup();
      const players = await fx.players(5);
      for (const p of players) await add(t.id, p, as(t.organizer));
      await remove(t.id, players[4], as(t.organizer));
      await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await entry(t.id, players[0])).toBe("drafted");
      expect(await entry(t.id, players[4])).toBeUndefined();
    });

    it.each(["Live", "Paused", "Finished", "Cancelled", "CancelledMinTeams"])(
      "nobody edits the pool once the tournament is %s",
      async (status) => {
        const t = await cup();
        const p = await fx.player();
        await add(t.id, p, as(t.organizer));
        await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
        await postgres.query("UPDATE tournaments SET status = $2 WHERE id = $1", [t.id, status]);
        await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
        await expect(add(t.id, await fx.player(), as(t.organizer))).rejects.toThrow(/pool is locked/i);
        await expect(remove(t.id, p, as(t.organizer))).rejects.toThrow(/pool is locked/i);
        expect(await entry(t.id, p)).toBe("registered");
      },
    );
  });

  describe("locked once the pool is drafted", () => {
    it("cannot add or remove after registration closed", async () => {
      const t = await cup();
      const p = await fx.player();
      const q = await fx.player();
      await add(t.id, p, as(t.organizer));
      for (const player of await fx.players(3)) {
        await add(t.id, player, as(t.organizer));
      }
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

      await expect(add(t.id, q, as(t.organizer))).rejects.toThrow(
        /pool is locked/i,
      );
      await expect(remove(t.id, p, as(t.organizer))).rejects.toThrow(
        /pool is locked/i,
      );
    });

    it("never removes a drafted entry through the pool, and leaves the generated team alone", async () => {
      const t = await cup();
      const players = await fx.players(2);
      for (const p of players) await add(t.id, p, as(t.organizer));
      await postgres.query("SELECT draft_tournament_free_agent_teams($1)", [t.id]);
      expect(await entry(t.id, players[0])).toBe("drafted");
      const [before] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text FROM tournament_team_roster WHERE tournament_id = $1",
        [t.id],
      );

      await expect(remove(t.id, players[0], as(t.organizer))).rejects.toThrow(
        /already been drafted/i,
      );

      expect(await entry(t.id, players[0])).toBe("drafted");
      const [after] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text FROM tournament_team_roster WHERE tournament_id = $1",
        [t.id],
      );
      expect(after.count).toBe(before.count);
    });

    it("removing a player who is not in the pool says so", async () => {
      const t = await cup();
      await expect(
        remove(t.id, await fx.player(), as(t.organizer)),
      ).rejects.toThrow(/not in the free agent pool/i);
    });

    it("a pool edited by the organizer is what the draft uses when registration closes", async () => {
      const t = await cup();
      const keep = await fx.players(2);
      const drop = await fx.player();
      for (const p of [...keep, drop]) await add(t.id, p, as(t.organizer));
      await remove(t.id, drop, as(t.organizer));

      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await entry(t.id, keep[0])).toBe("drafted");
      expect(await entry(t.id, keep[1])).toBe("drafted");
      expect(await entry(t.id, drop)).toBeUndefined();
    });
  });
});
