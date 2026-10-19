import { readFileSync } from "node:fs";
import path from "node:path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournaments.award_rules_version decides a tournament's automatic placement
// medals. Every tournament from before the migration keeps rules 1 (the
// original DEAFCS selection), whatever recalculates it; tournaments created
// after it take rules 2, 5Stack upstream's (5stackgg/api 30ca37b3): a shared
// 3rd gets no bronze and a final stage played in groups gets no medals.
describe("tournament award rules (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentAwardRulesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199697000000n);
    tfx = new TournamentFixtures(postgres, fx);
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
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  type Medal = { placement: number; tournament_team_id: string };

  // One row per placement and team: the team recipient and its players.
  const medals = async (tournamentId: string): Promise<Array<Medal>> =>
    postgres.query<Array<Medal>>(
      `SELECT DISTINCT o.placement, r.tournament_team_id
         FROM award_occurrences o
         JOIN award_recipients r ON r.occurrence_id = o.id
        WHERE o.tournament_id = $1
          AND o.source = 'tournament_calculated'
          AND r.revoked_at IS NULL
        ORDER BY o.placement, r.tournament_team_id`,
      [tournamentId],
    );

  const playerMedals = async (tournamentId: string, placement: number) => {
    const [row] = await postgres.query<Array<{ players: number }>>(
      `SELECT count(*)::int AS players
         FROM award_occurrences o
         JOIN award_recipients r ON r.occurrence_id = o.id
        WHERE o.tournament_id = $1 AND o.placement = $2
          AND o.source = 'tournament_calculated'
          AND r.player_steam_id IS NOT NULL`,
      [tournamentId, placement],
    );
    return row.players;
  };

  // Lineup 1 wins every match that exists until the stage is played out.
  const playStage = async (stageId: string): Promise<void> => {
    for (let pass = 0; pass < 20; pass++) {
      const pending = await postgres.query<Array<{ match_id: string }>>(
        `SELECT tb.match_id
           FROM tournament_brackets tb
           JOIN matches m ON m.id = tb.match_id
          WHERE tb.tournament_stage_id = $1
            AND tb.finished = false
            AND m.winning_lineup_id IS NULL
          ORDER BY tb.round, tb.match_number`,
        [stageId],
      );
      if (pending.length === 0) {
        return;
      }
      for (const { match_id } of pending) {
        await tfx.winMatch(match_id);
      }
    }
  };

  // A tournament as the migration leaves an existing one: rules 1.
  const asExisting = (tournamentId: string) =>
    postgres.query(
      `ALTER TABLE tournaments DISABLE TRIGGER tbu_tournaments;
       UPDATE tournaments SET award_rules_version = 1 WHERE id = '${tournamentId}';
       ALTER TABLE tournaments ENABLE TRIGGER tbu_tournaments;`,
    );

  const singleElimination = async ({
    rules,
    thirdPlaceMatch,
  }: {
    rules: 1 | 2;
    thirdPlaceMatch: boolean;
  }) => {
    const t = await tfx.createTournament([
      {
        type: "SingleElimination",
        order: 1,
        minTeams: 4,
        maxTeams: 4,
        thirdPlaceMatch,
      },
    ]);
    if (rules === 1) {
      await asExisting(t.id);
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");
    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");

    const finalRound = await postgres.query<
      Array<{ team_1: string; team_2: string }>
    >(
      `SELECT tournament_team_id_1 AS team_1, tournament_team_id_2 AS team_2
         FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND round = 2 AND path = 'WB'
        ORDER BY match_number`,
      [t.stageIds[0]],
    );
    const [standingsThird] = await postgres.query<
      Array<{ tournament_team_id: string }>
    >(
      `SELECT tournament_team_id FROM v_team_stage_results
        WHERE tournament_stage_id = $1 AND placement = 3`,
      [t.stageIds[0]],
    );
    return {
      ...t,
      final: finalRound[0],
      decider: finalRound[1],
      standingsThird: standingsThird?.tournament_team_id,
    };
  };

  const groupFinal = async (rules: 1 | 2) => {
    const t = await tfx.createTournament([
      { type: "RoundRobin", order: 1, minTeams: 8, maxTeams: 8 },
    ]);
    await postgres.query(
      "UPDATE tournament_stages SET groups = 2 WHERE id = $1",
      [t.stageIds[0]],
    );
    if (rules === 1) {
      await asExisting(t.id);
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 8; i++) {
      await tfx.registerTeam(t.id, await fx.team(1));
    }
    await tfx.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tfx.setStatus(t.id, t.organizer, "Live");
    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const recalculate = (tournamentId: string) =>
    postgres.query("SELECT * FROM recalculate_tournament_awards($1)", [
      tournamentId,
    ]);

  const toggleAwards = async (t: { id: string; organizer: string }) => {
    for (const enabled of [false, true]) {
      await runAsUser(postgres, t.organizer, "admin", (query) =>
        query(
          "UPDATE tournaments SET awards_enabled = $2, trophies_enabled = $2 WHERE id = $1",
          [t.id, enabled],
        ),
      );
    }
  };

  // The organizer's reset of the final: Finished -> Live clears the
  // calculated medals, and finishing again recalculates them.
  const resetAndReplayFinal = async (t: {
    id: string;
    stageIds: Array<string>;
  }) => {
    const [final] = await postgres.query<Array<{ match_id: string }>>(
      `SELECT match_id FROM tournament_brackets
        WHERE tournament_stage_id = $1 AND path = 'WB' AND match_number = 1
        ORDER BY round DESC LIMIT 1`,
      [t.stageIds[0]],
    );
    await postgres.query("SELECT * FROM reset_tournament_match($1)", [
      final.match_id,
    ]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Live");
    expect(await medals(t.id)).toEqual([]);
    await playStage(t.stageIds[0]);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
  };

  describe("the column", () => {
    it("is 2 for a tournament created now", async () => {
      const t = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      const [row] = await postgres.query<
        Array<{ award_rules_version: number }>
      >("SELECT award_rules_version FROM tournaments WHERE id = $1", [t.id]);
      expect(row.award_rules_version).toBe(2);
    });

    // The migration's own statements, run against a stand-in table that
    // already holds a row: the row it finds gets 1, a row inserted after it 2.
    it("is 1 for a tournament the migration found", async () => {
      const up = readFileSync(
        path.resolve(
          __dirname,
          "../hasura/migrations/default/1890900000300_tournament_award_rules_version/up.sql",
        ),
        "utf8",
      ).replaceAll("public.tournaments", "award_rules_stand_in");
      await postgres.query(
        `DROP TABLE IF EXISTS award_rules_stand_in;
         CREATE TABLE award_rules_stand_in (id int PRIMARY KEY);
         INSERT INTO award_rules_stand_in VALUES (1);`,
      );
      try {
        await postgres.query(up);
        await postgres.query(
          "INSERT INTO award_rules_stand_in (id) VALUES (2)",
        );
        const rows = await postgres.query<
          Array<{ id: number; award_rules_version: number }>
        >(
          "SELECT id, award_rules_version FROM award_rules_stand_in ORDER BY id",
        );
        expect(rows).toEqual([
          { id: 1, award_rules_version: 1 },
          { id: 2, award_rules_version: 2 },
        ]);

        // Re-running it (a repeated init) changes nothing.
        await postgres.query(up);
        const again = await postgres.query<
          Array<{ id: number; award_rules_version: number }>
        >(
          "SELECT id, award_rules_version FROM award_rules_stand_in ORDER BY id",
        );
        expect(again).toEqual(rows);
      } finally {
        await postgres.query("DROP TABLE IF EXISTS award_rules_stand_in");
      }
    });

    it("cannot be changed on an existing tournament", async () => {
      const t = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      await expect(
        runAsUser(postgres, t.organizer, "admin", (query) =>
          query(
            "UPDATE tournaments SET award_rules_version = 1 WHERE id = $1",
            [t.id],
          ),
        ),
      ).rejects.toThrow(/Award rules cannot be changed/);
    });

    it("only allows 1 and 2", async () => {
      const t = await tfx.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      await expect(
        postgres.query(
          `ALTER TABLE tournaments DISABLE TRIGGER tbu_tournaments;
           UPDATE tournaments SET award_rules_version = 3 WHERE id = '${t.id}';`,
        ),
      ).rejects.toThrow(/award_rules_version_check/);
      await postgres.query(
        "ALTER TABLE tournaments ENABLE TRIGGER tbu_tournaments",
      );
    });

    it("is not writable through Hasura", () => {
      const yaml = readFileSync(
        path.resolve(
          __dirname,
          "../hasura/metadata/databases/default/tables/public_tournaments.yaml",
        ),
        "utf8",
      );
      expect(yaml).not.toContain("award_rules_version");
    });
  });

  describe("rules 1 (existing tournaments)", () => {
    it("single elimination without a third-place match keeps the bronze for the standings' 3rd", async () => {
      const t = await singleElimination({ rules: 1, thirdPlaceMatch: false });

      expect(await medals(t.id)).toEqual(
        [
          { placement: 1, tournament_team_id: t.final.team_1 },
          { placement: 2, tournament_team_id: t.final.team_2 },
          { placement: 3, tournament_team_id: t.standingsThird },
        ].sort((a, b) => a.placement - b.placement),
      );
      expect(await playerMedals(t.id, 3)).toBeGreaterThan(0);
    });

    it("keeps the same medals through every recalculation", async () => {
      const t = await singleElimination({ rules: 1, thirdPlaceMatch: false });
      const earned = await medals(t.id);

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await medals(t.id)).toEqual(earned);

      await recalculate(t.id);
      expect(await medals(t.id)).toEqual(earned);

      await toggleAwards(t);
      expect(await medals(t.id)).toEqual(earned);

      await resetAndReplayFinal(t);
      expect(await medals(t.id)).toEqual(earned);
    });

    it("gives the bronze to the third-place match winner", async () => {
      const t = await singleElimination({ rules: 1, thirdPlaceMatch: true });

      expect(await medals(t.id)).toEqual([
        { placement: 1, tournament_team_id: t.final.team_1 },
        { placement: 2, tournament_team_id: t.final.team_2 },
        { placement: 3, tournament_team_id: t.decider.team_1 },
      ]);
    });

    it("still medals a final stage played in groups as before (gold and silver, no bronze)", async () => {
      const t = await groupFinal(1);

      const placements = (await medals(t.id)).map((m) => m.placement);
      expect(placements).toEqual([1, 2]);

      await recalculate(t.id);
      expect((await medals(t.id)).map((m) => m.placement)).toEqual([1, 2]);
    });
  });

  describe("rules 2 (tournaments created after the migration)", () => {
    it("gives no bronze for a shared 3rd", async () => {
      const t = await singleElimination({ rules: 2, thirdPlaceMatch: false });

      expect(await medals(t.id)).toEqual([
        { placement: 1, tournament_team_id: t.final.team_1 },
        { placement: 2, tournament_team_id: t.final.team_2 },
      ]);
      expect(await playerMedals(t.id, 3)).toBe(0);
    });

    it("gives the bronze to the third-place match winner", async () => {
      const t = await singleElimination({ rules: 2, thirdPlaceMatch: true });

      expect(await medals(t.id)).toEqual([
        { placement: 1, tournament_team_id: t.final.team_1 },
        { placement: 2, tournament_team_id: t.final.team_2 },
        { placement: 3, tournament_team_id: t.decider.team_1 },
      ]);
      expect(await playerMedals(t.id, 3)).toBeGreaterThan(0);
    });

    it("medals the same teams the podium shows", async () => {
      const t = await singleElimination({ rules: 2, thirdPlaceMatch: true });
      const [row] = await postgres.query<
        Array<{ podium: Array<Medal & { name: string }> }>
      >(
        "SELECT tournament_podium(t) AS podium FROM tournaments t WHERE t.id = $1",
        [t.id],
      );

      expect(await medals(t.id)).toEqual(
        row.podium.map(({ placement, tournament_team_id }) => ({
          placement,
          tournament_team_id,
        })),
      );
    });

    it("gives no medals for a final stage played in groups", async () => {
      const t = await groupFinal(2);

      expect(await medals(t.id)).toEqual([]);
      const [{ occurrences }] = await postgres.query<
        Array<{ occurrences: number }>
      >(
        `SELECT count(*)::int AS occurrences FROM award_occurrences
          WHERE tournament_id = $1 AND source = 'tournament_calculated'`,
        [t.id],
      );
      expect(occurrences).toBe(0);
    });

    it("keeps the same medals through every recalculation", async () => {
      const t = await singleElimination({ rules: 2, thirdPlaceMatch: true });
      const earned = await medals(t.id);

      await recalculate(t.id);
      expect(await medals(t.id)).toEqual(earned);

      await toggleAwards(t);
      expect(await medals(t.id)).toEqual(earned);

      await resetAndReplayFinal(t);
      expect(await medals(t.id)).toEqual(earned);
    });
  });
});
