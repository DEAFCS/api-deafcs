import * as fs from "fs";
import * as path from "path";
import { MatchesController } from "../src/matches/matches.controller";
import { CheckForScheduledTournamentBrackets } from "../src/matches/jobs/CheckForScheduledTournamentBrackets";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A match a tournament bracket points at is never hard-deleted from the generic
// delete: the bracket keeps its slot (and a finished slot keeps its winner) with
// no match to reset. A slot that is already orphaned can be repaired through the
// supported tournament flow, and the winner reset keeps working.
describe("tournament match delete safety and orphan recovery (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let cups: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentMatchDeleteSafety");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199972000000n);
    cups = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const SE4 = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }];

  const launch = (type = "Wingman") => cups.launch(SE4, 4, type);

  const controller = (hasuraOverrides: Record<string, unknown> = {}) => {
    const c = Object.create(MatchesController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn() };
    c.postgres = postgres;
    c.clips = { deleteClipsForMatch: jest.fn() };
    c.demoMetadata = { deleteDemosForMatch: jest.fn() };
    c.hasura = {
      query: jest.fn(async ({ matches_by_pk }: any) => {
        const [m] = await postgres.query<Array<{ id: string; status: string }>>(
          "SELECT id, status FROM matches WHERE id = $1",
          [matches_by_pk.__args.id],
        );
        return { matches_by_pk: m ?? null };
      }),
      mutation: jest.fn(async ({ delete_matches_by_pk }: any) => {
        await postgres.query("DELETE FROM matches WHERE id = $1", [
          delete_matches_by_pk.__args.id,
        ]);
        return { delete_matches_by_pk: { __typename: "matches" } };
      }),
      ...hasuraOverrides,
    };
    return c;
  };

  const brackets = (stageId: string) => cups.getBrackets(stageId);
  const bracketOf = async (stageId: string, round: number, n: number) =>
    (await brackets(stageId)).find((b) => b.round === round && b.match_number === n)!;

  const matchCount = async (bracketId: string) => {
    const [r] = await postgres.query<Array<{ n: string }>>(
      "SELECT count(*)::text AS n FROM tournament_brackets WHERE id = $1 AND match_id IS NOT NULL",
      [bracketId],
    );
    return Number(r.n);
  };

  const session = (steam: string, role = "user") =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steam });

  const recreate = (bracketId: string, scheduledAt: string | null = null) =>
    postgres.query<Array<{ id: string }>>(
      "SELECT recreate_tournament_bracket_match($1::uuid, $2::timestamptz) AS id",
      [bracketId, scheduledAt],
    );

  describe("generic delete", () => {
    it("rejects a tournament match and leaves bracket and match untouched", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 1);
      const c = controller();

      await expect(c.deleteMatch({ match_id: b.match_id })).rejects.toThrow(
        /must be reset or cancelled from the tournament bracket/i,
      );

      expect(c.hasura.mutation).not.toHaveBeenCalled();
      expect(c.clips.deleteClipsForMatch).not.toHaveBeenCalled();
      const [still] = await postgres.query<Array<{ n: string }>>(
        "SELECT count(*)::text AS n FROM matches WHERE id = $1",
        [b.match_id],
      );
      expect(Number(still.n)).toBe(1);
      expect(await matchCount(b.id)).toBe(1);
    });

    it("rejects a canceled or finished tournament match as well", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await cups.winMatch(b.match_id!);
      await expect(controller().deleteMatch({ match_id: b.match_id })).rejects.toThrow(
        /tournament bracket/i,
      );
    });

    it("still deletes a normal match that is not in any bracket", async () => {
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
         SELECT 8, 1, 'Wingman', id, false, true, '{TestA}' FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      );
      const organizer = await fx.player();
      const [m] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO matches (status, organizer_steam_id, match_options_id)
         VALUES ('Finished', $1, $2) RETURNING id`,
        [organizer, options.id],
      );
      const c = controller();

      await expect(c.deleteMatch({ match_id: m.id })).resolves.toEqual({ success: true });

      const [gone] = await postgres.query<Array<{ n: string }>>(
        "SELECT count(*)::text AS n FROM matches WHERE id = $1",
        [m.id],
      );
      expect(Number(gone.n)).toBe(0);
    });

    it("the Hasura delete permission refuses tournament matches too", () => {
      // Bypassing the action (a direct delete mutation) is closed in metadata.
      const yaml = fs.readFileSync(
        path.join(
          __dirname,
          "../hasura/metadata/databases/default/tables/public_matches.yaml",
        ),
        "utf8",
      );
      const deleteBlock = yaml.slice(yaml.indexOf("delete_permissions:"), yaml.indexOf("event_triggers:"));
      const admin = deleteBlock.slice(
        deleteBlock.indexOf("role: administrator"),
        deleteBlock.indexOf("role: user"),
      );
      const user = deleteBlock.slice(deleteBlock.indexOf("role: user"));
      for (const block of [admin, user]) {
        expect(block).toMatch(/_not:\s*\n\s*tournament_brackets: \{\}/);
      }
      expect(user).toContain("is_organizer");
    });
  });

  describe("orphaned bracket recovery", () => {
    it("an unfinished orphan with both teams gets its match back, once, linked to its bracket", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);
      expect(await matchCount(b.id)).toBe(0);

      const [{ id }] = await recreate(b.id);

      const [linked] = await postgres.query<Array<{ match_id: string; finished: boolean }>>(
        "SELECT match_id, finished FROM tournament_brackets WHERE id = $1",
        [b.id],
      );
      expect(linked.match_id).toBe(id);
      expect(linked.finished).toBe(false);
      // Not a second time.
      await expect(recreate(b.id)).rejects.toThrow(/already has a match/i);
      const [count] = await postgres.query<Array<{ n: string }>>(
        "SELECT count(*)::text AS n FROM tournament_brackets WHERE match_id = $1",
        [id],
      );
      expect(Number(count.n)).toBe(1);
    });

    it("a finished orphan is replayed: its winner is taken back from the next round", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await cups.winMatch(b.match_id!);
      const before = await bracketOf(t.stageIds[0], 2, 1);
      expect(before.tournament_team_id_2 ?? before.tournament_team_id_1).not.toBeNull();
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);
      const orphan = await bracketOf(t.stageIds[0], 1, 2);
      expect(orphan.finished).toBe(true);
      expect(orphan.match_id).toBeNull();

      // A schedule alone changes nothing for a finished slot.
      await postgres.query(
        "UPDATE tournament_brackets SET scheduled_at = now() + interval '5 minutes' WHERE id = $1",
        [b.id],
      );
      const job = new CheckForScheduledTournamentBrackets({ log: jest.fn() } as any, postgres);
      expect(await job.process()).toBe(0);
      expect(await matchCount(b.id)).toBe(0);

      const [{ id }] = await recreate(b.id);

      const after = await bracketOf(t.stageIds[0], 1, 2);
      expect(after.match_id).toBe(id);
      expect(after.finished).toBe(false);
      // The slot it fed is empty again, with the other feeder's team untouched.
      const final = await bracketOf(t.stageIds[0], 2, 1);
      const winnerSlots = [final.tournament_team_id_1, final.tournament_team_id_2].filter(Boolean);
      expect(winnerSlots).toHaveLength(0);
      const [m] = await postgres.query<Array<{ status: string; winning_lineup_id: string | null }>>(
        "SELECT status, winning_lineup_id FROM matches WHERE id = $1",
        [id],
      );
      expect(m.winning_lineup_id).toBeNull();
      expect(["WaitingForCheckIn", "Scheduled"]).toContain(m.status);
    });

    it("the recreated match seats the current starting lineup, not the whole roster", async () => {
      const t = await cups.createTournament(SE4, "Wingman");
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = 2
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id],
      );
      await cups.setStatus(t.id, t.organizer, "RegistrationOpen");
      for (let i = 0; i < 4; i++) await cups.registerTeam(t.id, await fx.team(3));
      await cups.setStatus(t.id, t.organizer, "RegistrationClosed");
      await cups.setStatus(t.id, t.organizer, "Live");
      const b = await bracketOf(t.stageIds[0], 1, 1);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);

      const [{ id }] = await recreate(b.id);

      const lineups = await postgres.query<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM match_lineup_players mlp
          JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
         WHERE ml.match_id = $1 GROUP BY ml.id`,
        [id],
      );
      expect(lineups.map((r) => Number(r.n))).toEqual([2, 2]);
    });

    it("the scheduler still recreates an unfinished orphan once it has a schedule", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);
      await postgres.query(
        "UPDATE tournament_brackets SET scheduled_at = now() + interval '5 minutes' WHERE id = $1",
        [b.id],
      );
      const job = new CheckForScheduledTournamentBrackets({ log: jest.fn() } as any, postgres);
      expect(await job.process()).toBe(1);
      expect(await matchCount(b.id)).toBe(1);
    });

    it("refuses what is not a plain orphan", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 1);
      // Has a match.
      await expect(recreate(b.id)).rejects.toThrow(/already has a match/i);
      // Not both teams: the final before its feeders are decided.
      const final = await bracketOf(t.stageIds[0], 2, 1);
      await expect(recreate(final.id)).rejects.toThrow(/both teams/i);
      // A bye.
      await postgres.query("UPDATE tournament_brackets SET bye = true, match_id = NULL WHERE id = $1", [b.id]);
      await expect(recreate(b.id)).rejects.toThrow(/bye/i);
      // Unknown bracket.
      await expect(recreate("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/i);
    });

    it("refuses when the tournament is not running", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);
      await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
      await postgres.query("UPDATE tournaments SET status = 'Cancelled' WHERE id = $1", [t.id]);
      await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
      await expect(recreate(b.id)).rejects.toThrow(/not running/i);
    });

    it("refuses when a match downstream has already started", async () => {
      const t = await launch();
      await cups.playRound(t.stageIds[0], 1);
      const final = await bracketOf(t.stageIds[0], 2, 1);
      await postgres.query("ALTER TABLE matches DISABLE TRIGGER USER");
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [final.match_id]);
      await postgres.query("ALTER TABLE matches ENABLE TRIGGER USER");
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);

      await expect(recreate(b.id)).rejects.toThrow(/already started/i);
      expect(await matchCount(b.id)).toBe(0);
    });

    it("the action is for organizers only", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 2);
      await postgres.query("DELETE FROM matches WHERE id = $1", [b.match_id]);
      const c = controller();
      const outsider = await fx.player();

      await expect(
        c.RecreateTournamentBracketMatch({
          user: { steam_id: outsider, role: "user" },
          bracket_id: b.id,
        }),
      ).rejects.toThrow(/not a tournament organizer/i);
      expect(await matchCount(b.id)).toBe(0);

      const result = await c.RecreateTournamentBracketMatch({
        user: { steam_id: t.organizer, role: "user" },
        bracket_id: b.id,
      });
      expect(result.success).toBe(true);
      expect(await matchCount(b.id)).toBe(1);
      void session;
    });
  });

  describe("winner reset keeps working", () => {
    const reset = (matchId: string) =>
      postgres.query("SELECT * FROM reset_tournament_match($1, NULL, 'WaitingForCheckIn', NULL)", [matchId]);

    it("resets a canceled tournament match", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 1);
      await postgres.query("UPDATE matches SET status = 'Canceled' WHERE id = $1", [b.match_id]);
      await reset(b.match_id!);
      const [m] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [b.match_id],
      );
      expect(m.status).toBe("WaitingForCheckIn");
      expect(await matchCount(b.id)).toBe(1);
    });

    it("resets a forfeited match and its downstream chain", async () => {
      const t = await launch();
      const b = await bracketOf(t.stageIds[0], 1, 1);
      await postgres.query(
        "UPDATE matches SET status = 'Forfeit', winning_lineup_id = lineup_1_id WHERE id = $1",
        [b.match_id],
      );
      const advanced = await bracketOf(t.stageIds[0], 2, 1);
      expect([advanced.tournament_team_id_1, advanced.tournament_team_id_2].filter(Boolean).length).toBe(1);

      await reset(b.match_id!);

      const cleared = await bracketOf(t.stageIds[0], 2, 1);
      expect([cleared.tournament_team_id_1, cleared.tournament_team_id_2].filter(Boolean)).toHaveLength(0);
      const after = await bracketOf(t.stageIds[0], 1, 1);
      expect(after.finished).toBe(false);
      expect(after.match_id).toBe(b.match_id);
    });

    it("resets a finished match whose winner already played the next round", async () => {
      const t = await launch();
      await cups.playRound(t.stageIds[0], 1);
      const b = await bracketOf(t.stageIds[0], 1, 1);
      const final = await bracketOf(t.stageIds[0], 2, 1);
      expect(final.match_id).not.toBeNull();

      const rows = await reset(b.match_id!);

      expect((rows as any[]).length).toBe(1); // the final was removed
      const after = await bracketOf(t.stageIds[0], 2, 1);
      expect(after.match_id).toBeNull();
      expect(after.finished).toBe(false);
    });
  });
});
