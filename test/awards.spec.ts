import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { AwardsService } from "./../src/awards/awards.service";
import { AwardsController } from "./../src/awards/awards.controller";
import { TrophiesLegacyController } from "./../src/awards/trophies-legacy.controller";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Covers the awards layer that sits under tournament placements: the catalog
// fallback, per-tournament overrides, source-scoped recalculation, and the
// constraints that keep a grant pointing at exactly one recipient.
describe("awards (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("AwardsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
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
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM awards WHERE system_key IS NULL");
    // seasons carries an exclusion constraint against overlapping ranges, so
    // leftovers from one test collide with the next one's open-ended season.
    await postgres.query("DELETE FROM seasons");
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];
  const SE4_WITH_THIRD = [
    {
      type: "SingleElimination",
      order: 1,
      minTeams: 4,
      maxTeams: 8,
      thirdPlaceMatch: true,
    },
  ];

  const playedOutCup = async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const playedOutCupWithThirdPlace = async (matchType = "Wingman") => {
    const t = await tfx.launch(SE4_WITH_THIRD, 4, matchType);
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const setTournamentMatchType = (tournamentId: string, type: string) =>
    postgres.query(
      `UPDATE match_options mo
          SET type = $2
         FROM tournaments t
        WHERE t.id = $1 AND mo.id = t.match_options_id`,
      [tournamentId, type],
    );

  const calculatedPlacements = async (tournamentId: string) =>
    (
      await postgres.query<Array<{ placement: number }>>(
        `SELECT placement
           FROM award_occurrences
          WHERE tournament_id = $1 AND source = 'tournament_calculated'
          ORDER BY placement`,
        [tournamentId],
      )
    ).map((row) => row.placement);

  const seedWinningRosterImpact = (tournamentId: string) =>
    postgres.query(
      `WITH winner AS (
         SELECT ar.tournament_team_id
           FROM award_occurrences ao
           JOIN award_recipients ar ON ar.occurrence_id = ao.id
          WHERE ao.tournament_id = $1
            AND ao.source = 'tournament_calculated'
            AND ao.placement = 1
          LIMIT 1
       )
       INSERT INTO player_elo
         (steam_id, match_id, type, "current", change, impact, created_at)
       SELECT lp.steam_id, b.match_id, 'Competitive', 5000, 0, 2.0, now()
         FROM winner w
         JOIN tournament_brackets b
           ON w.tournament_team_id IN
              (b.tournament_team_id_1, b.tournament_team_id_2)
         JOIN matches m ON m.id = b.match_id
         JOIN match_lineup_players lp
           ON lp.match_lineup_id = CASE
             WHEN b.tournament_team_id_1 = w.tournament_team_id
               THEN m.lineup_1_id
             ELSE m.lineup_2_id
           END
        WHERE b.finished
        LIMIT 1`,
      [tournamentId],
    );

  const createAward = async (
    name: string,
    tier = "special",
    allowMultiple = false,
  ) => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO awards (name, tier, allow_multiple) VALUES ($1, $2, $3) RETURNING id`,
      [name, tier, allowMultiple],
    );
    return award.id;
  };

  const systemAward = async (key: string) => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM awards WHERE system_key = $1",
      [key],
    );
    return award.id;
  };

  describe("catalog", () => {
    it("ships the four tournament system awards", async () => {
      const rows = await postgres.query<
        Array<{ system_key: string; tier: string }>
      >(
        `SELECT system_key, tier FROM awards
          WHERE system_key LIKE 'tournament\\_%' ORDER BY system_key`,
      );
      expect(rows.map((r) => r.system_key)).toEqual([
        "tournament_bronze",
        "tournament_gold",
        "tournament_mvp",
        "tournament_silver",
      ]);
      expect(rows.map((r) => r.tier)).toEqual([
        "bronze",
        "gold",
        "mvp",
        "silver",
      ]);
    });

    it("scopes an award to at most one owner", async () => {
      const t = await playedOutCup();
      const [season] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id`,
      );

      await expect(
        postgres.query(
          `INSERT INTO awards (name, tier, tournament_id, elo_season_id)
            VALUES ('Two Homes', 'special', $1, $2)`,
          [t.id, season.id],
        ),
      ).rejects.toThrow(/single.scope|historical award identity/i);

      await postgres.query(
        `INSERT INTO awards (name, tier, elo_season_id) VALUES ('Season Award', 'special', $1)`,
        [season.id],
      );
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM awards WHERE elo_season_id = $1",
        [season.id],
      );
      expect(Number(c)).toBe(1);
    });

    it("refuses to scope a built-in award", async () => {
      const t = await playedOutCup();
      await expect(
        postgres.query(
          "UPDATE awards SET tournament_id = $1 WHERE system_key = 'tournament_gold'",
          [t.id],
        ),
      ).rejects.toThrow(/single.scope|historical award identity/i);
    });

    it("rejects a tier outside the enum", async () => {
      await expect(
        postgres.query(
          "INSERT INTO awards (name, tier) VALUES ('Bad', 'plat')",
        ),
      ).rejects.toThrow();
    });

    it("refuses to delete a system award even from raw SQL", async () => {
      await expect(
        postgres.query(
          "DELETE FROM awards WHERE system_key = 'tournament_gold'",
        ),
      ).rejects.toThrow(/cannot be deleted/i);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM awards WHERE system_key = 'tournament_gold'",
      );
      expect(Number(c)).toBe(1);
    });

    it("requires used custom awards to be archived", async () => {
      const awardId = await createAward("Temporary");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      await expect(
        postgres.query("DELETE FROM awards WHERE id = $1", [awardId]),
      ).rejects.toThrow(/must be archived/i);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM tournament_trophies WHERE award_id = $1",
        [awardId],
      );
      expect(Number(c)).toBe(1);
    });

    it("deletes an unused custom award", async () => {
      const awardId = await createAward("Unused");
      await postgres.query("DELETE FROM awards WHERE id=$1", [awardId]);
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM awards WHERE id=$1",
        [awardId],
      );
      expect(Number(c)).toBe(0);
    });

    it("keeps league divisions attached to their league season scope", async () => {
      const [constraint] = await postgres.query<Array<{ definition: string }>>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'award_occurrences'::regclass
            AND conname = 'award_occurrences_single_scope'`,
      );
      expect(constraint.definition).toContain(
        "league_season_division_id IS NULL",
      );
      expect(constraint.definition).toContain("league_season_id IS NOT NULL");
    });

    it("returns generated ids from both legacy compatibility views", async () => {
      const steamId = await fx.player();
      const awardId = await createAward("Legacy ID");
      const [recipient] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_trophies
            (award_id, player_steam_id)
          VALUES ($1, $2)
          RETURNING id`,
        [awardId, steamId],
      );
      expect(recipient.id).toBeTruthy();

      const t = await tfx.createTournament(SE4);
      const [config] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO tournament_trophy_configs
            (tournament_id, placement, custom_name)
          VALUES ($1, 1, 'Legacy config')
          RETURNING id`,
        [t.id],
      );
      expect(config.id).toBeTruthy();
    });
  });

  describe("granting", () => {
    it("requires exactly one recipient", async () => {
      const awardId = await createAward("Clutch King");
      const steamId = await fx.player();
      const team = await fx.team();

      await expect(
        postgres.query(
          "INSERT INTO tournament_trophies (award_id, source) VALUES ($1, 'manual')",
          [awardId],
        ),
      ).rejects.toThrow(/one_recipient/i);

      await expect(
        postgres.query(
          `INSERT INTO tournament_trophies (award_id, player_steam_id, team_id, source)
            VALUES ($1, $2, $3, 'manual')`,
          [awardId, steamId, team.id],
        ),
      ).rejects.toThrow(/one_recipient/i);
    });

    it("grants an award with no tournament attached", async () => {
      const awardId = await createAward("Community MVP");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      const [row] = await postgres.query<
        Array<{ tournament_id: string | null; placement: number | null }>
      >(
        "SELECT tournament_id, placement FROM tournament_trophies WHERE award_id = $1",
        [awardId],
      );
      expect(row.tournament_id).toBeNull();
      expect(row.placement).toBeNull();
    });

    it("fans a team grant out to the roster so it reaches player pages", async () => {
      const awardId = await createAward("Squad Honour");
      const team = await fx.team(3);

      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND role <> 'Invite'",
        [team.id],
      );
      expect(roster.length).toBeGreaterThan(1);

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, team_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, team.id],
      );
      await postgres.query(
        `INSERT INTO tournament_trophies
            (award_id, player_steam_id, source)
          SELECT $1, r.player_steam_id, 'manual'
            FROM team_roster r
           WHERE r.team_id = $2 AND r.role <> 'Invite'`,
        [awardId, team.id],
      );

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        `SELECT count(*) AS c FROM tournament_trophies
          WHERE award_id = $1 AND player_steam_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(c)).toBe(roster.length);

      const [{ t }] = await postgres.query<Array<{ t: string }>>(
        `SELECT count(*) AS t FROM tournament_trophies
          WHERE award_id = $1 AND team_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(t)).toBe(1);
    });

    it("blocks a repeat grant unless the award allows multiples", async () => {
      const onceId = await createAward("One Time Only");
      const manyId = await createAward("Player of the Month", "special", true);
      const steamId = await fx.player();

      const grant = (awardId: string) =>
        postgres.query(
          `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
            VALUES ($1, $2, 'manual')`,
          [awardId, steamId],
        );

      await grant(onceId);
      await expect(grant(onceId)).rejects.toThrow(/already granted/i);

      await grant(manyId);
      await grant(manyId);
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM tournament_trophies WHERE award_id = $1",
        [manyId],
      );
      expect(Number(c)).toBe(2);
    });

    it("blocks a repeat hand-grant inside the same tournament", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");
      const [seat] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id FROM tournament_trophies
          WHERE tournament_id = $1 AND player_steam_id IS NOT NULL LIMIT 1`,
        [t.id],
      );

      const grant = () =>
        postgres.query(
          `INSERT INTO tournament_trophies
              (award_id, tournament_id, tournament_team_id, player_steam_id, source)
            VALUES ($1, $2, $3, $4, 'manual')`,
          [awardId, t.id, seat.tournament_team_id, seat.player_steam_id],
        );

      await grant();
      // Placement is NULL on a hand-grant, so the partial unique keys never
      // bind; the trigger is what stops the duplicate.
      await expect(grant()).rejects.toThrow(/already granted/i);
    });

    it("skips roster members who already hold the award when fanning out", async () => {
      const awardId = await createAward("Squad Honour");
      const team = await fx.team(3);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND role <> 'Invite'",
        [team.id],
      );

      // One member already holds it before the team grant fans out.
      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, roster[0].player_steam_id],
      );

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          SELECT $1, r.player_steam_id, 'manual'
            FROM team_roster r
           WHERE r.team_id = $2
             AND r.role <> 'Invite'
             AND NOT EXISTS (
               SELECT 1 FROM tournament_trophies held
                WHERE held.award_id = $1
                  AND held.player_steam_id = r.player_steam_id
                  AND held.tournament_id IS NOT DISTINCT FROM NULL
             )`,
        [awardId, team.id],
      );

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        `SELECT count(*) AS c FROM tournament_trophies
          WHERE award_id = $1 AND player_steam_id = $2`,
        [awardId, roster[0].player_steam_id],
      );
      expect(Number(c)).toBe(1);

      const [{ total }] = await postgres.query<Array<{ total: string }>>(
        `SELECT count(*) AS total FROM tournament_trophies
          WHERE award_id = $1 AND player_steam_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(total)).toBe(roster.length);
    });

    it("refuses a tournament team without its tournament", async () => {
      const awardId = await createAward("Orphan");
      const steamId = await fx.player();

      await expect(
        postgres.query(
          `INSERT INTO tournament_trophies
              (award_id, player_steam_id, tournament_team_id, source)
            VALUES ($1, $2, gen_random_uuid(), 'manual')`,
          [awardId, steamId],
        ),
      ).rejects.toThrow();
    });
  });

  describe("tournament calculation", () => {
    it.each([
      ["Duel", "1v1"],
      ["Wingman", "2v2"],
    ])("does not calculate MVP for a %s (%s) tournament", async (type) => {
      const t = await playedOutCupWithThirdPlace(type);
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      expect(await calculatedPlacements(t.id)).toEqual([1, 2, 3]);
    });

    it("calculates MVP for 5v5 and remains idempotent", async () => {
      const t = await playedOutCupWithThirdPlace("Competitive");

      await seedWinningRosterImpact(t.id);
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await calculatedPlacements(t.id)).toEqual([0, 1, 2, 3]);

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await calculatedPlacements(t.id)).toEqual([0, 1, 2, 3]);
    });

    it("removes an invalid calculated MVP on recalc without touching manual grants", async () => {
      const t = await playedOutCupWithThirdPlace("Competitive");
      await seedWinningRosterImpact(t.id);
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      expect(await calculatedPlacements(t.id)).toEqual([0, 1, 2, 3]);

      const awardId = await createAward("Organizer's Pick");
      const [seat] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id
           FROM tournament_trophies
          WHERE tournament_id = $1 AND player_steam_id IS NOT NULL
          LIMIT 1`,
        [t.id],
      );
      await postgres.query(
        `INSERT INTO tournament_trophies
            (award_id, tournament_id, tournament_team_id, player_steam_id, source)
          VALUES ($1, $2, $3, $4, 'manual')`,
        [awardId, t.id, seat.tournament_team_id, seat.player_steam_id],
      );

      await setTournamentMatchType(t.id, "Wingman");
      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      expect(await calculatedPlacements(t.id)).toEqual([1, 2, 3]);
      const [{ manual }] = await postgres.query<Array<{ manual: string }>>(
        `SELECT count(*) AS manual
           FROM tournament_trophies
          WHERE tournament_id = $1 AND source = 'manual'`,
        [t.id],
      );
      expect(Number(manual)).toBe(1);
    });

    it("falls back to the system award for each placement", async () => {
      const t = await playedOutCup();

      const rows = await postgres.query<
        Array<{ placement: number; system_key: string }>
      >(
        `SELECT DISTINCT ar.placement, a.system_key
           FROM tournament_trophies ar
           JOIN awards a ON a.id = ar.award_id
          WHERE ar.tournament_id = $1
          ORDER BY ar.placement`,
        [t.id],
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.system_key).toBe(
          { 0: "tournament_mvp", 1: "tournament_gold", 2: "tournament_silver" }[
            Number(row.placement)
          ] ?? "tournament_bronze",
        );
      }
    });

    it("uses the per-tournament award override when one is configured", async () => {
      const t = await playedOutCup();
      const customId = await createAward("Summer Cup Champion", "gold", true);

      await postgres.query(
        `INSERT INTO tournament_award_slots (tournament_id, slot, award_id)
          VALUES ($1, 'champion', $2)
          ON CONFLICT (tournament_id, slot)
          DO UPDATE SET award_id=excluded.award_id`,
        [t.id, customId],
      );
      await postgres.query("SELECT recalculate_tournament_awards($1)", [t.id]);

      const golds = await postgres.query<Array<{ award_id: string }>>(
        `SELECT DISTINCT award_id FROM tournament_trophies
          WHERE tournament_id = $1 AND placement = 1`,
        [t.id],
      );
      expect(golds.map((g) => g.award_id)).toEqual([customId]);

      // Placements without an override still resolve to their system award.
      const silvers = await postgres.query<Array<{ award_id: string }>>(
        `SELECT DISTINCT award_id FROM tournament_trophies
          WHERE tournament_id = $1 AND placement = 2`,
        [t.id],
      );
      expect(silvers.map((s) => s.award_id)).toEqual([
        await systemAward("tournament_silver"),
      ]);
    });

    it("rebuilds calculated rows on recalc while hand-granted rows survive", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");

      const [seat] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id FROM tournament_trophies
          WHERE tournament_id = $1 AND player_steam_id IS NOT NULL LIMIT 1`,
        [t.id],
      );

      await postgres.query(
        `INSERT INTO tournament_trophies
            (award_id, tournament_id, tournament_team_id, player_steam_id, source)
          VALUES ($1, $2, $3, $4, 'manual')`,
        [awardId, t.id, seat.tournament_team_id, seat.player_steam_id],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      const [counts] = await postgres.query<
        Array<{ calculated: string; manual: string }>
      >(
        `SELECT
            count(*) FILTER (WHERE source = 'tournament') AS calculated,
            count(*) FILTER (WHERE source = 'manual') AS manual
           FROM tournament_trophies WHERE tournament_id = $1`,
        [t.id],
      );
      expect(Number(counts.calculated)).toBeGreaterThan(0);
      expect(Number(counts.manual)).toBe(1);
    });

    it("excludes roster substitutes who never appeared in a completed match", async () => {
      const t = await playedOutCup();
      const [winner] = await postgres.query<
        Array<{ tournament_team_id: string }>
      >(
        `SELECT tournament_team_id
           FROM tournament_trophies
          WHERE tournament_id=$1 AND placement=1
            AND tournament_team_id IS NOT NULL
          LIMIT 1`,
        [t.id],
      );
      const substitute = await fx.player();
      const [replaced] = await postgres.query<
        Array<{ player_steam_id: string }>
      >(
        `DELETE FROM tournament_team_roster
          WHERE ctid IN (
            SELECT ctid
              FROM tournament_team_roster
             WHERE tournament_id=$1 AND tournament_team_id=$2
             LIMIT 1
          )
          RETURNING player_steam_id`,
        [t.id, winner.tournament_team_id],
      );
      expect(replaced.player_steam_id).toBeTruthy();
      await postgres.query(
        `INSERT INTO tournament_team_roster
            (tournament_id, tournament_team_id, player_steam_id)
          VALUES ($1, $2, $3)`,
        [t.id, winner.tournament_team_id, substitute],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        `SELECT count(*) AS c
           FROM tournament_trophies
          WHERE tournament_id=$1 AND player_steam_id=$2`,
        [t.id, substitute],
      );
      expect(Number(c)).toBe(0);
    });

    it("removes obsolete calculated occurrences that have no recipients", async () => {
      const t = await playedOutCup();
      const awardId = await systemAward("tournament_bronze");
      const [obsolete] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO award_occurrences
            (award_id,tournament_id,placement,source,calculation_key)
          VALUES ($1,$2,3,'tournament_calculated',$3)
          RETURNING id`,
        [awardId, t.id, `tournament:${t.id}:obsolete`],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM award_occurrences WHERE id=$1",
        [obsolete.id],
      );
      expect(Number(c)).toBe(0);
    });

    it("keeps hand-granted awards out of the medal leaderboard", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Community MVP");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      const rows = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM get_leaderboard('trophies', 0)",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => String(r.player_steam_id))).not.toContain(
        String(steamId),
      );
      void t;
    });
  });

  describe("awards_enabled", () => {
    it("round-trips the calculated rows without touching hand-granted ones", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO tournament_trophies (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      const calculated = async () =>
        Number(
          (
            await postgres.query<Array<{ c: string }>>(
              `SELECT count(*) AS c FROM tournament_trophies
                WHERE tournament_id = $1 AND source = 'tournament'`,
              [t.id],
            )
          )[0].c,
        );

      expect(await calculated()).toBeGreaterThan(0);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [t.id],
      );
      expect(await calculated()).toBe(0);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = true WHERE id = $1",
        [t.id],
      );
      expect(await calculated()).toBeGreaterThan(0);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM tournament_trophies WHERE award_id = $1",
        [awardId],
      );
      expect(Number(c)).toBe(1);
    });

    it("defaults a newly created tournament to awards disabled", async () => {
      const organizer = await fx.player();
      const [options] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
          SELECT 8, 1, 'Wingman', id, false, true, '{TestA}'
          FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      );
      // Deliberately omits awards_enabled/trophies_enabled -- this is the
      // real column default, not TournamentFixtures' explicit override.
      const [tournament] = await postgres.query<
        Array<{ awards_enabled: boolean; trophies_enabled: boolean }>
      >(
        `INSERT INTO tournaments
            (name, start, organizer_steam_id, match_options_id, status)
          VALUES ($1, now() + interval '1 day', $2, $3, 'Setup')
          RETURNING awards_enabled, trophies_enabled`,
        ["default-awards-cup", organizer, options.id],
      );
      expect(tournament.awards_enabled).toBe(false);
      expect(tournament.trophies_enabled).toBe(false);
    });

    it("preserves tournament_award_slots across disabling and re-enabling", async () => {
      const t = await playedOutCup();
      const customId = await createAward("Kept Slot", "gold", true);
      await postgres.query(
        `INSERT INTO tournament_award_slots (tournament_id, slot, award_id)
          VALUES ($1, 'champion', $2)
          ON CONFLICT (tournament_id, slot)
          DO UPDATE SET award_id=excluded.award_id`,
        [t.id, customId],
      );

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [t.id],
      );
      await postgres.query(
        "UPDATE tournaments SET awards_enabled = true WHERE id = $1",
        [t.id],
      );

      const [slot] = await postgres.query<Array<{ award_id: string }>>(
        `SELECT award_id FROM tournament_award_slots
          WHERE tournament_id = $1 AND slot = 'champion'`,
        [t.id],
      );
      expect(slot.award_id).toBe(customId);
    });
  });
  // The table permissions are read-only, so every write path runs through the
  // action layer. These cover the authorization it adds on top of the SQL
  // constraints exercised above.
  describe("actions", () => {
    let controller: AwardsController;
    let service: AwardsService;
    let s3: {
      put: jest.Mock;
      remove: jest.Mock;
      has: jest.Mock;
    };
    let createFloor: string;
    let grantFloor: string;

    beforeEach(() => {
      createFloor = "administrator";
      grantFloor = "administrator";

      s3 = {
        put: jest.fn(),
        remove: jest.fn(),
        has: jest.fn().mockResolvedValue(false),
      };
      service = new AwardsService(
        new Logger("AwardsActionTest"),
        s3 as never,
        postgres,
      );

      controller = new AwardsController(service, {
        getSetting: async (name: string) =>
          name.includes("create") ? createFloor : grantFloor,
      } as never);
    });

    const user = (steam_id: string, role: string) =>
      ({ steam_id, role }) as never;

    const rosterOf = async (tournamentId: string) => {
      const [row] = await postgres.query<
        Array<{ player_steam_id: string; team_id: string }>
      >(
        `SELECT r.player_steam_id, tt.team_id
           FROM tournament_team_roster r
           JOIN tournament_teams tt ON tt.id = r.tournament_team_id
          WHERE r.tournament_id = $1
          LIMIT 1`,
        [tournamentId],
      );
      return row;
    };

    describe("saveAward", () => {
      it("rejects a role below the create floor", async () => {
        const steam = await fx.player();

        await expect(
          controller.saveAward({
            name: "Rejected",
            tier: "special",
            user: user(steam, "user"),
          }),
        ).rejects.toThrow("permission to manage awards");
      });

      it("lets a tournament organizer scope an award to their own tournament", async () => {
        const t = await tfx.createTournament(SE4);
        createFloor = "user";

        const award = await controller.saveAward({
          name: "Organizer's Pick",
          tier: "special",
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        expect(award.tournament_id).toBe(t.id);
      });

      it("refuses to scope an award to someone else's tournament", async () => {
        const t = await tfx.createTournament(SE4);
        const stranger = await fx.player();
        createFloor = "user";

        await expect(
          controller.saveAward({
            name: "Not Mine",
            tier: "special",
            tournament_id: t.id,
            user: user(stranger, "user"),
          }),
        ).rejects.toThrow("Not the tournament organizer");
      });

      it("keeps event, season and league scoping to administrators", async () => {
        const season = await fx.season(new Date().toISOString());
        createFloor = "user";

        await expect(
          controller.saveAward({
            name: "Season Special",
            tier: "special",
            elo_season_id: season,
            user: user(await fx.player(), "tournament_organizer"),
          }),
        ).rejects.toThrow("Only administrators");

        const award = await controller.saveAward({
          name: "Season Special",
          tier: "special",
          elo_season_id: season,
          user: user(await fx.player(), "administrator"),
        });
        expect(award.elo_season_id).toBe(season);
      });

      it("prevents a non-admin from taking over another tournament's award", async () => {
        const owned = await tfx.createTournament(SE4);
        const other = await tfx.createTournament(SE4);
        const [award] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO awards (name,tier,tournament_id)
            VALUES ('Owned award','special',$1)
            RETURNING id`,
          [owned.id],
        );
        createFloor = "user";

        await expect(
          controller.saveAward({
            id: award.id,
            name: "Taken over",
            tier: "special",
            tournament_id: other.id,
            user: user(other.organizer, "user"),
          }),
        ).rejects.toThrow("Not the tournament organizer");
      });
    });

    describe("deleteAward", () => {
      it("refuses to delete a built-in award", async () => {
        await expect(
          controller.deleteAward({
            id: await systemAward("tournament_gold"),
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("cannot be deleted");
      });

      it("prevents a non-admin from archiving or deleting an unrelated award", async () => {
        const owned = await tfx.createTournament(SE4);
        const other = await tfx.createTournament(SE4);
        const [award] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO awards (name,tier,tournament_id)
            VALUES ('Protected','special',$1)
            RETURNING id`,
          [owned.id],
        );
        createFloor = "user";
        const outsider = user(other.organizer, "user");

        await expect(
          controller.archiveAward({
            id: award.id,
            archived: true,
            user: outsider,
          }),
        ).rejects.toThrow("Not the tournament organizer");
        await expect(
          controller.deleteAward({ id: award.id, user: outsider }),
        ).rejects.toThrow("Not the tournament organizer");
      });

      it("archives custom awards but never built-in definitions", async () => {
        const custom = await createAward("Archivable");
        const administrator = user(await fx.player(), "administrator");

        const archived = await controller.archiveAward({
          id: custom,
          archived: true,
          user: administrator,
        });
        expect(archived.archived_at).not.toBeNull();
        await expect(
          controller.grantAward({
            award_id: custom,
            player_steam_id: await fx.player(),
            user: administrator,
          }),
        ).rejects.toThrow("Archived awards cannot be granted");

        await expect(
          controller.archiveAward({
            id: await systemAward("tournament_gold"),
            archived: true,
            user: administrator,
          }),
        ).rejects.toThrow("cannot be archived");
      });
    });

    describe("grantAward", () => {
      it("rejects a global grant from a role below the grant floor", async () => {
        const awardId = await createAward("Community Pick");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            user: user(await fx.player(), "tournament_organizer"),
          }),
        ).rejects.toThrow("permission to grant awards");
      });

      it("lets an organizer below the floor grant inside their own tournament", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Clutch King");
        const roster = await rosterOf(t.id);

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: roster.player_steam_id,
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        expect(granted.id).toBeTruthy();

        // ...but not in a tournament they do not run.
        const other = await tfx.createTournament(SE4);
        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: roster.player_steam_id,
            tournament_id: other.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("Not the tournament organizer");
      });

      it("refuses a recipient who never played in the tournament", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Outsider");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            tournament_id: t.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("not part of this tournament");
      });

      it("refuses a grant that names more than one scope", async () => {
        const t = await tfx.createTournament(SE4);
        const season = await fx.season(new Date().toISOString());
        const awardId = await createAward("Confused");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            tournament_id: t.id,
            elo_season_id: season,
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("one scope at most");
      });

      it("stamps the season on a season-scoped grant", async () => {
        const season = await fx.season(new Date().toISOString());
        const awardId = await createAward("Season Special");
        const steam = await fx.player();

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: steam,
          elo_season_id: season,
          user: user(await fx.player(), "administrator"),
        });

        const [row] = await postgres.query<Array<{ elo_season_id: string }>>(
          `SELECT o.elo_season_id
             FROM award_recipients r
             JOIN award_occurrences o ON o.id=r.occurrence_id
            WHERE r.id=$1`,
          [granted.id],
        );
        expect(row.elo_season_id).toBe(season);
      });

      it("runs occurrence creation and recipient fan-out in one transaction", async () => {
        const transaction = jest.spyOn(postgres, "transaction");
        const awardId = await createAward("Transactional");

        await controller.grantAward({
          award_id: awardId,
          player_steam_id: await fx.player(),
          user: user(await fx.player(), "administrator"),
        });

        expect(transaction).toHaveBeenCalledTimes(1);
        transaction.mockRestore();
      });

      it("denies a manual player grant when the tournament has awards disabled", async () => {
        const t = await playedOutCup();
        await postgres.query(
          "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
          [t.id],
        );
        const awardId = await createAward("Should Be Blocked");
        const roster = await rosterOf(t.id);

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: roster.player_steam_id,
            tournament_id: t.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("Awards are disabled for this tournament");
      });

      it("denies a manual team grant when the tournament has awards disabled", async () => {
        const t = await playedOutCup();
        await postgres.query(
          "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
          [t.id],
        );
        const awardId = await createAward("Should Be Blocked Team", "special", true);
        const roster = await rosterOf(t.id);

        await expect(
          controller.grantAward({
            award_id: awardId,
            team_id: roster.team_id,
            tournament_id: t.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("Awards are disabled for this tournament");
      });

      it("allows a manual grant when the tournament has awards enabled", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Should Be Allowed");
        const roster = await rosterOf(t.id);

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: roster.player_steam_id,
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });
        expect(granted.id).toBeTruthy();
      });
    });

    describe("setTournamentAward", () => {
      it("rejects archived and foreign-scoped award definitions", async () => {
        const tournament = await tfx.createTournament(SE4);
        const other = await tfx.createTournament(SE4);
        const [archived] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO awards (name,tier,archived_at)
            VALUES ('Archived','special',now())
            RETURNING id`,
        );
        const [foreign] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO awards (name,tier,tournament_id)
            VALUES ('Foreign','special',$1)
            RETURNING id`,
          [other.id],
        );
        const organizer = user(tournament.organizer, "user");

        await expect(
          controller.setTournamentAward({
            tournament_id: tournament.id,
            placement: 1,
            award_id: archived.id,
            user: organizer,
          }),
        ).rejects.toThrow("Archived awards cannot be selected");

        await expect(
          controller.setTournamentAward({
            tournament_id: tournament.id,
            placement: 1,
            award_id: foreign.id,
            user: organizer,
          }),
        ).rejects.toThrow("not available to this tournament");
      });

      it("still allows configuring award slots while the tournament has awards disabled", async () => {
        const tournament = await tfx.createTournament(SE4);
        await postgres.query(
          "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
          [tournament.id],
        );
        const awardId = await createAward("Preselected", "gold", true);

        const result = await controller.setTournamentAward({
          tournament_id: tournament.id,
          placement: 1,
          award_id: awardId,
          user: user(tournament.organizer, "user"),
        });
        expect(result).toBeTruthy();

        const [slot] = await postgres.query<Array<{ award_id: string }>>(
          `SELECT award_id FROM tournament_award_slots
            WHERE tournament_id = $1 AND slot = 'champion'`,
          [tournament.id],
        );
        expect(slot.award_id).toBe(awardId);
      });
    });

    describe("artwork", () => {
      it("keeps the legacy tournament artwork routes", () => {
        const upload = TrophiesLegacyController.prototype.upload;
        const remove = TrophiesLegacyController.prototype.remove;
        expect(Reflect.getMetadata(PATH_METADATA, upload)).toBe(
          ":tournamentId/:placement",
        );
        expect(Reflect.getMetadata(METHOD_METADATA, upload)).toBe(
          RequestMethod.POST,
        );
        expect(Reflect.getMetadata(PATH_METADATA, remove)).toBe(
          ":tournamentId/:placement",
        );
        expect(Reflect.getMetadata(METHOD_METADATA, remove)).toBe(
          RequestMethod.DELETE,
        );
      });

      it("persists award and tournament-slot images in the correct columns", async () => {
        const awardId = await createAward("Artwork");
        const awardPath = await service.uploadAwardImage(
          awardId,
          Buffer.from("image"),
          "image/png",
        );
        const [award] = await postgres.query<Array<{ image_url: string }>>(
          "SELECT image_url FROM awards WHERE id=$1",
          [awardId],
        );
        expect(award.image_url).toBe(awardPath);
        await service.removeAwardImage(awardId);
        const [clearedAward] = await postgres.query<
          Array<{ image_url: string | null }>
        >("SELECT image_url FROM awards WHERE id=$1", [awardId]);
        expect(clearedAward.image_url).toBeNull();

        const tournament = await tfx.createTournament(SE4);
        const slotPath = await service.uploadTournamentAwardImage(
          tournament.id,
          1,
          Buffer.from("image"),
          "image/png",
        );
        const [slot] = await postgres.query<Array<{ image_override: string }>>(
          `SELECT image_override
             FROM tournament_award_slots
            WHERE tournament_id=$1 AND slot='champion'`,
          [tournament.id],
        );
        expect(slot.image_override).toBe(slotPath);

        await service.removeTournamentAwardImage(tournament.id, 1);
        const [cleared] = await postgres.query<
          Array<{ image_override: string | null }>
        >(
          `SELECT image_override
             FROM tournament_award_slots
            WHERE tournament_id=$1 AND slot='champion'`,
          [tournament.id],
        );
        expect(cleared.image_override).toBeNull();
      });

      it("removes a newly uploaded object when database persistence fails", async () => {
        const awardId = await createAward("Cleanup");
        const originalQuery = postgres.query.bind(postgres);
        const query = jest
          .spyOn(postgres, "query")
          .mockImplementationOnce((sql, bindings) =>
            originalQuery(sql, bindings),
          )
          .mockRejectedValueOnce(new Error("database unavailable"));

        await expect(
          service.uploadAwardImage(awardId, Buffer.from("image"), "image/png"),
        ).rejects.toThrow("database unavailable");
        expect(s3.remove).toHaveBeenCalledWith(
          expect.stringMatching(/^awards\//),
        );
        query.mockRestore();
      });

      it("cleans up a new tournament image when slot persistence fails", async () => {
        const tournament = await tfx.createTournament(SE4);
        const originalQuery = postgres.query.bind(postgres);
        const query = jest
          .spyOn(postgres, "query")
          .mockImplementationOnce((sql, bindings) =>
            originalQuery(sql, bindings),
          )
          .mockRejectedValueOnce(new Error("database unavailable"));

        await expect(
          service.uploadTournamentAwardImage(
            tournament.id,
            1,
            Buffer.from("image"),
            "image/png",
          ),
        ).rejects.toThrow("database unavailable");
        expect(s3.remove).toHaveBeenCalledWith(
          expect.stringMatching(/^awards\//),
        );
        query.mockRestore();
      });
    });

    describe("revokeAward", () => {
      it("refuses to revoke a calculated tournament placement", async () => {
        const t = await playedOutCup();
        const [calculated] = await postgres.query<Array<{ id: string }>>(
          `SELECT id FROM tournament_trophies
            WHERE tournament_id = $1 AND source = 'tournament' LIMIT 1`,
          [t.id],
        );

        await expect(
          controller.revokeAward({
            id: calculated.id,
            reason: "test revocation",
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("managed by the tournament");
      });

      it("removes a hand-granted row", async () => {
        const awardId = await createAward("Removable");
        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: await fx.player(),
          user: user(await fx.player(), "administrator"),
        });

        await controller.revokeAward({
          id: granted.id,
          reason: "test revocation",
          user: user(await fx.player(), "administrator"),
        });

        const rows = await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM tournament_trophies WHERE id = $1",
          [granted.id],
        );
        expect(rows).toHaveLength(0);
      });

      it("lets the owning organizer soft-revoke a manual tournament award", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Organizer revocation");
        const roster = await rosterOf(t.id);
        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: roster.player_steam_id,
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        await controller.revokeAward({
          id: granted.id,
          reason: "Granted in error",
          user: user(t.organizer, "user"),
        });

        const [stored] = await postgres.query<
          Array<{ revoked_at: string | null; revocation_reason: string | null }>
        >(
          `SELECT revoked_at,revocation_reason
             FROM award_recipients
            WHERE id=$1`,
          [granted.id],
        );
        expect(stored.revoked_at).not.toBeNull();
        expect(stored.revocation_reason).toBe("Granted in error");
      });

      it("still allows revoking a manual award after the tournament disables awards", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Revoke While Disabled");
        const roster = await rosterOf(t.id);
        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: roster.player_steam_id,
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        await postgres.query(
          "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
          [t.id],
        );

        await controller.revokeAward({
          id: granted.id,
          reason: "test revocation while disabled",
          user: user(t.organizer, "user"),
        });

        const [stored] = await postgres.query<
          Array<{ revoked_at: string | null }>
        >(`SELECT revoked_at FROM award_recipients WHERE id=$1`, [
          granted.id,
        ]);
        expect(stored.revoked_at).not.toBeNull();
      });
    });
  });
});
