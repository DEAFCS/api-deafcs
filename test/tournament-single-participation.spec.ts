import { TournamentRegistrationService } from "../src/tournaments/tournament-registration.service";
import { TournamentRegistrationController } from "../src/tournaments/tournament-registration.controller";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

type PoolClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
};

// DEAFCS: one entry per player per tournament. A player in the Free Agent pool
// cannot also be on a team, own one or captain one, and the other way round.
// The second entry is refused; nobody is withdrawn from the pool or taken off a
// team without leaving first (5Stack instead deletes the pool row).
describe("tournament single participation: Free Agent or team, never both (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  const pool = () =>
    (
      postgres as unknown as {
        pool: { connect(): Promise<PoolClient> };
      }
    ).pool;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentSingleParticipation");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199972000000n);
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

  // Wingman: a lineup of two, so a team of owner + 1 mate is complete.
  const cup = async (registrationType = "both", version = 2) => {
    const t = await cups.createTournament(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      "Wingman",
      version,
    );
    if (version === 2) {
      await postgres.query(
        "UPDATE tournaments SET registration_type = $2 WHERE id = $1",
        [t.id, registrationType],
      );
    }
    await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  };

  const joinPool = (tournamentId: string, player: string) =>
    controller().joinTournamentAsFreeAgent({
      user: as(player),
      tournament_id: tournamentId,
    });

  const leavePool = (tournamentId: string, player: string) =>
    controller().leaveTournamentAsFreeAgent({
      user: as(player),
      tournament_id: tournamentId,
    });

  const poolStatus = async (tournamentId: string, player: string) => {
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournament_free_agents WHERE tournament_id = $1 AND player_steam_id = $2",
      [tournamentId, player],
    );
    return row?.status;
  };

  const rosterTeam = async (tournamentId: string, player: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      "SELECT tournament_team_id::text AS id FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
      [tournamentId, player],
    );
    return row?.id;
  };

  const teamCount = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ n: string }>>(
      "SELECT count(*)::text AS n FROM tournament_teams WHERE tournament_id = $1",
      [tournamentId],
    );
    return Number(row.n);
  };

  const teamMate = async (teamId: string, owner: string) => {
    const [row] = await postgres.query<Array<{ steam: string }>>(
      "SELECT player_steam_id::text AS steam FROM team_roster WHERE team_id = $1 AND player_steam_id <> $2 LIMIT 1",
      [teamId, owner],
    );
    return row.steam;
  };

  // Registered the way the web does it: a plain insert as the player's session.
  const registerTeamAs = (
    tournamentId: string,
    teamId: string,
    steamId: string,
  ) =>
    runAsUser(postgres, steamId, "user", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id::text AS id`,
        [tournamentId, teamId],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const createPickupTeamAs = (tournamentId: string, owner: string) =>
    runAsUser(postgres, owner, "user", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
         VALUES ($1, $2, $3) RETURNING id::text AS id`,
        [tournamentId, fx.nextName("pickup"), owner],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const addToRosterAs = (
    tournamentId: string,
    tournamentTeamId: string,
    player: string,
    actor: string,
    role = "user",
  ) =>
    runAsUser(postgres, actor, role, (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, player, tournamentId],
      ),
    );

  describe("Free Agent first, then a team", () => {
    it("a Free Agent cannot register their own team", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await joinPool(t.id, team.owner);

      await expect(registerTeamAs(t.id, team.id, team.owner)).rejects.toThrow(
        /You are a Free Agent in this tournament\. Leave the Free Agent pool first to register a team\./,
      );
      expect(await teamCount(t.id)).toBe(0);
      expect(await poolStatus(t.id, team.owner)).toBe("registered");
    });

    it("a Free Agent cannot create a new team for this tournament", async () => {
      const t = await cup();
      const p = await fx.player();
      await joinPool(t.id, p);

      await expect(createPickupTeamAs(t.id, p)).rejects.toThrow(
        /You are a Free Agent in this tournament/,
      );
      expect(await teamCount(t.id)).toBe(0);
    });

    it("a team whose captain is a Free Agent cannot be registered by its owner", async () => {
      const t = await cup();
      const team = await fx.team(1);
      const mate = await teamMate(team.id, team.owner);
      await postgres.query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        team.id,
        mate,
      ]);
      await joinPool(t.id, mate);

      await expect(registerTeamAs(t.id, team.id, team.owner)).rejects.toThrow(
        /This team's owner or captain is a Free Agent in this tournament/,
      );
      expect(await poolStatus(t.id, mate)).toBe("registered");
    });

    it("roster auto-fill leaves a Free Agent team member in the pool and off the lineup", async () => {
      const t = await cup();
      const team = await fx.team(2);
      const mates = await postgres.query<Array<{ steam: string }>>(
        "SELECT player_steam_id::text AS steam FROM team_roster WHERE team_id = $1 AND player_steam_id <> $2 ORDER BY player_steam_id",
        [team.id, team.owner],
      );
      const freeAgent = mates[0].steam;
      await joinPool(t.id, freeAgent);

      const ttId = await registerTeamAs(t.id, team.id, team.owner);

      expect(await rosterTeam(t.id, freeAgent)).toBeUndefined();
      expect(await poolStatus(t.id, freeAgent)).toBe("registered");
      expect(await rosterTeam(t.id, team.owner)).toBe(ttId);
      expect(await rosterTeam(t.id, mates[1].steam)).toBe(ttId);
    });

    it("a captain or owner cannot add a Free Agent to the tournament roster", async () => {
      const t = await cup();
      const team = await fx.team(1);
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      const p = await fx.player();
      await joinPool(t.id, p);

      await expect(addToRosterAs(t.id, ttId, p, team.owner)).rejects.toThrow(
        /This player is a Free Agent in this tournament\. They need to leave the Free Agent pool first\./,
      );
      expect(await rosterTeam(t.id, p)).toBeUndefined();
      expect(await poolStatus(t.id, p)).toBe("registered");
    });

    it("an organizer or administrator cannot put a Free Agent on a team either", async () => {
      const t = await cup();
      const team = await fx.team(1);
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      const p = await fx.player();
      await joinPool(t.id, p);

      await expect(
        addToRosterAs(t.id, ttId, p, t.organizer, "user"),
      ).rejects.toThrow(/This player is a Free Agent in this tournament/);
      await expect(
        addToRosterAs(t.id, ttId, p, t.organizer, "admin"),
      ).rejects.toThrow(/This player is a Free Agent in this tournament/);
      expect(await poolStatus(t.id, p)).toBe("registered");
    });

    it("a Free Agent can be invited, but accepting waits until they leave the pool", async () => {
      const t = await cup();
      const owner = await fx.player();
      const ttId = await createPickupTeamAs(t.id, owner);
      const p = await fx.player();
      await joinPool(t.id, p);

      // The owner's add becomes an invite (no roster row, no error).
      await addToRosterAs(t.id, ttId, p, owner);
      const invites = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_team_invites WHERE tournament_team_id = $1 AND steam_id = $2",
        [ttId, p],
      );
      expect(invites.length).toBe(1);

      // Accepting is the player's own roster insert.
      await expect(addToRosterAs(t.id, ttId, p, p)).rejects.toThrow(
        /You are a Free Agent in this tournament\. Leave the Free Agent pool first to join a team\./,
      );
      expect(await rosterTeam(t.id, p)).toBeUndefined();
      expect(await poolStatus(t.id, p)).toBe("registered");

      // Leaving the pool is the way to switch.
      await leavePool(t.id, p);
      await addToRosterAs(t.id, ttId, p, p);
      expect(await rosterTeam(t.id, p)).toBe(ttId);
    });

    it("a waitlisted or drafted Free Agent counts as in the tournament too", async () => {
      const t = await cup();
      const team = await fx.team(1);
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      const waitlisted = await fx.player();
      await joinPool(t.id, waitlisted);
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'waitlisted' WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, waitlisted],
      );

      await expect(
        addToRosterAs(t.id, ttId, waitlisted, team.owner),
      ).rejects.toThrow(/This player is a Free Agent/);
      await expect(createPickupTeamAs(t.id, waitlisted)).rejects.toThrow(
        /You are a Free Agent/,
      );
    });

    it("leaving the pool first makes registering a team possible", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await joinPool(t.id, team.owner);
      await leavePool(t.id, team.owner);

      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      expect(await rosterTeam(t.id, team.owner)).toBe(ttId);
      expect(await poolStatus(t.id, team.owner)).toBeUndefined();
    });

    it("a withdrawn pool row does not block a team", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await joinPool(t.id, team.owner);
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'withdrawn' WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, team.owner],
      );

      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      expect(await rosterTeam(t.id, team.owner)).toBe(ttId);
      expect(await poolStatus(t.id, team.owner)).toBe("withdrawn");
    });

    it("a team cannot be handed to an owner who is a Free Agent in a tournament it is in", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await registerTeamAs(t.id, team.id, team.owner);
      const p = await fx.player();
      await joinPool(t.id, p);
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status, role) VALUES ($1, $2, 'Starter', 'Admin')",
          [team.id, p],
        ),
      );

      await expect(
        postgres.query("UPDATE teams SET owner_steam_id = $2 WHERE id = $1", [
          team.id,
          p,
        ]),
      ).rejects.toThrow(/The new owner is a Free Agent/);
      expect(await poolStatus(t.id, p)).toBe("registered");
    });
  });

  describe("team first, then the Free Agent pool", () => {
    it("a rostered player cannot sign up as a Free Agent", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await registerTeamAs(t.id, team.id, team.owner);
      const mate = await teamMate(team.id, team.owner);

      await expect(joinPool(t.id, mate)).rejects.toThrow(
        "You are already on a team in this tournament. Leave your team first to sign up as a Free Agent.",
      );
      expect(await poolStatus(t.id, mate)).toBeUndefined();
    });

    it("the database refuses it too, for the player and for an organizer adding them", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await registerTeamAs(t.id, team.id, team.owner);
      const mate = await teamMate(team.id, team.owner);

      await expect(
        runAsUser(postgres, mate, "user", (query) =>
          query(
            "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
            [t.id, mate],
          ),
        ),
      ).rejects.toThrow(/You are already on a team in this tournament/);
      await expect(
        controller().addTournamentFreeAgent({
          user: as(t.organizer),
          tournament_id: t.id,
          player_steam_id: mate,
        }),
      ).rejects.toThrow(/This player is already on a team in this tournament/);
    });

    it("a team owner who is not on its roster cannot sign up as a Free Agent", async () => {
      const t = await cup();
      const owner = await fx.player();
      await createPickupTeamAs(t.id, owner);

      await expect(joinPool(t.id, owner)).rejects.toThrow(
        "You already have a team in this tournament",
      );
    });

    it("a withdrawn pool row cannot be restored while the player is on a team", async () => {
      const t = await cup();
      const team = await fx.team(0);
      const p = await fx.player();
      await joinPool(t.id, p);
      await postgres.query(
        "UPDATE tournament_free_agents SET status = 'withdrawn' WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, p],
      );
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      await addToRosterAs(t.id, ttId, p, t.organizer, "admin");

      await expect(
        runAsUser(postgres, t.organizer, "tournament_organizer", (query) =>
          query(
            "UPDATE tournament_free_agents SET status = 'registered' WHERE tournament_id = $1 AND player_steam_id = $2",
            [t.id, p],
          ),
        ),
      ).rejects.toThrow(/This player is already on a team in this tournament/);
      expect(await poolStatus(t.id, p)).toBe("withdrawn");
    });

    it("leaving the team first makes the Free Agent sign-up possible", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await registerTeamAs(t.id, team.id, team.owner);
      const mate = await teamMate(team.id, team.owner);
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
        [t.id, mate],
      );

      await expect(joinPool(t.id, mate)).resolves.toEqual({ success: true });
      expect(await poolStatus(t.id, mate)).toBe("registered");
    });
  });

  describe("concurrent attempts", () => {
    // One connection signs the player up and holds its transaction open; the
    // other tries to put the same player on a team. The registration lock makes
    // the second wait, then see the first, so exactly one entry survives.
    async function race(
      first: [string, unknown[]],
      second: [string, unknown[]],
    ) {
      const a = await pool().connect();
      const b = await pool().connect();
      try {
        await a.query("BEGIN");
        await a.query(...first);
        await b.query("BEGIN");
        const pending = b.query(...second).then(
          () => null,
          (error: Error) => error,
        );
        // Give b time to reach the lock before a commits.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await a.query("COMMIT");
        const error = await pending;
        await b.query(error ? "ROLLBACK" : "COMMIT");
        return error;
      } finally {
        // Never hand a connection back mid-transaction.
        await a.query("ROLLBACK").catch(() => undefined);
        await b.query("ROLLBACK").catch(() => undefined);
        a.release();
        b.release();
      }
    }

    it("a pool sign-up in flight blocks a roster insert for the same player", async () => {
      const t = await cup();
      const team = await fx.team(0);
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      const p = await fx.player();

      const error = await race(
        [
          "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
          [t.id, p],
        ],
        [
          "INSERT INTO tournament_team_roster (tournament_id, player_steam_id, tournament_team_id) VALUES ($1, $2, $3)",
          [t.id, p, ttId],
        ],
      );

      expect(String(error)).toMatch(/is a Free Agent in this tournament/);
      expect(await poolStatus(t.id, p)).toBe("registered");
      expect(await rosterTeam(t.id, p)).toBeUndefined();
    });

    it("a roster insert in flight blocks a pool sign-up for the same player", async () => {
      const t = await cup();
      const team = await fx.team(0);
      const ttId = await registerTeamAs(t.id, team.id, team.owner);
      const p = await fx.player();

      const error = await race(
        [
          "INSERT INTO tournament_team_roster (tournament_id, player_steam_id, tournament_team_id) VALUES ($1, $2, $3)",
          [t.id, p, ttId],
        ],
        [
          "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
          [t.id, p],
        ],
      );

      expect(String(error)).toMatch(/already on a team in this tournament/);
      expect(await rosterTeam(t.id, p)).toBe(ttId);
      expect(await poolStatus(t.id, p)).toBeUndefined();
    });

    it("a pool sign-up in flight blocks the same player's team registration", async () => {
      const t = await cup();
      const team = await fx.team(1);

      const error = await race(
        [
          "INSERT INTO tournament_free_agents (tournament_id, player_steam_id) VALUES ($1, $2)",
          [t.id, team.owner],
        ],
        [
          "INSERT INTO tournament_teams (tournament_id, team_id, name) SELECT $1, id, name FROM teams WHERE id = $2",
          [t.id, team.id],
        ],
      );

      expect(String(error)).toMatch(/owner or captain is a Free Agent/);
      expect(await teamCount(t.id)).toBe(0);
    });
  });

  describe("what stays the same", () => {
    it("the draft still turns the pool into teams next to a registered team", async () => {
      const t = await cup();
      const team = await fx.team(1);
      await registerTeamAs(t.id, team.id, team.owner);
      const players = await fx.players(6);
      for (const p of players) {
        await joinPool(t.id, p);
      }

      await postgres.query("SELECT draft_tournament_free_agent_teams($1)", [
        t.id,
      ]);

      for (const p of players) {
        expect(await poolStatus(t.id, p)).toBe("drafted");
        expect(await rosterTeam(t.id, p)).toBeDefined();
      }
      expect(await teamCount(t.id)).toBe(4);
    });

    it("leaving a drafted slot still promotes the waitlist", async () => {
      const t = await cup("free_agents");
      const players = await fx.players(9);
      for (const p of players) {
        await joinPool(t.id, p);
      }
      await postgres.query("SELECT draft_tournament_free_agent_teams($1)", [
        t.id,
      ]);
      const statuses = await Promise.all(
        players.map(async (p) => [p, await poolStatus(t.id, p)] as const),
      );
      const late = statuses.find(([, s]) => s === "waitlisted")?.[0];
      const drafted = statuses.find(([, s]) => s === "drafted")?.[0];
      expect(late).toBeDefined();
      expect(drafted).toBeDefined();

      await leavePool(t.id, drafted!);

      expect(await poolStatus(t.id, late!)).toBe("drafted");
      expect(await rosterTeam(t.id, late!)).toBeDefined();
    });

    it("version 1 tournaments are not touched", async () => {
      const t = await cup("both", 1);
      const team = await fx.team(1);
      const ttId = await cups.registerTeam(t.id, team);
      expect(await rosterTeam(t.id, team.owner)).toBe(ttId);
    });
  });
});
