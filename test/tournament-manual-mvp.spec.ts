jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { AwardsService } from "./../src/awards/awards.service";
import { AwardsController } from "./../src/awards/awards.controller";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// The tournament MVP is chosen by hand, after the tournament has finished,
// from players who actually played. Nothing here ranks or recommends anyone,
// and the choice is stored in the awards model so it stays historical.
describe("manual tournament MVP (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;
  let service: AwardsService;
  let controller: AwardsController;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentManualMvpTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199970000000n);
    tournaments = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
    service = new AwardsService(new Logger(), {} as never, postgres);
    controller = new AwardsController(service, {} as never);
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

  type Setup = {
    id: string;
    organizer: string;
    teams: Array<{ id: string; owner: string; ttId: string }>;
    matchId: string;
    mapId: string;
    lineup1: string;
    lineup2: string;
    seats1: string[];
    seats2: string[];
  };

  const stages = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  const seats = async (lineupId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      )
    ).map((r) => r.steam_id);

  // Four teams registered and the draw published, so round 1 exists and is
  // seated. `mates` extra players per team; `subs` is the substitute allowance.
  const setup = async ({
    type = "Competitive",
    mates = 4,
    subs = 0,
    awards = true,
  }: {
    type?: string;
    mates?: number;
    subs?: number;
    awards?: boolean;
  } = {}): Promise<Setup> => {
    const t = await tournaments.createTournament(stages, type);
    if (subs > 0) {
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = $2
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id, subs],
      );
    }
    if (!awards) {
      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false, trophies_enabled = false WHERE id = $1",
        [t.id],
      );
    }
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    const teams: Setup["teams"] = [];
    for (let i = 0; i < 4; i++) {
      const team = await fx.team(mates);
      teams.push({ ...team, ttId: await tournaments.registerTeam(t.id, team) });
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
    const [map] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_maps (match_id, map_id, "order")
       SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
      [bracket.match_id],
    );
    return {
      id: t.id,
      organizer: t.organizer,
      teams,
      matchId: bracket.match_id,
      mapId: map.id,
      lineup1: bracket.lineup_1_id,
      lineup2: bracket.lineup_2_id,
      seats1: await seats(bracket.lineup_1_id),
      seats2: await seats(bracket.lineup_2_id),
    };
  };

  // Forces Finished without playing the bracket out; the user triggers on
  // tournaments guard the real lifecycle and are not what is under test.
  const markFinished = async (id: string) => {
    await postgres.query("ALTER TABLE tournaments DISABLE TRIGGER USER");
    await postgres.query(
      "UPDATE tournaments SET status = 'Finished' WHERE id = $1",
      [id],
    );
    await postgres.query("ALTER TABLE tournaments ENABLE TRIGGER USER");
  };

  // Recorded activity: the listed players trade kills with the other side.
  const play = async (s: Setup, one: string[], two: string[]) => {
    for (let i = 0; i < Math.max(one.length, two.length); i++) {
      await fx.kill(
        { matchId: s.matchId, mapId: s.mapId },
        one[i % one.length],
        two[i % two.length],
      );
    }
  };

  const mvpRows = async (tournamentId: string) =>
    postgres.query<
      Array<{
        occurrence_id: string;
        source: string;
        placement: number;
        system_key: string;
        awarded_by: string | null;
        note: string | null;
        recipient_id: string;
        player_steam_id: string;
        tournament_team_id: string | null;
        revoked_at: Date | null;
        revoked_by: string | null;
        revocation_reason: string | null;
      }>
    >(
      `SELECT o.id AS occurrence_id, o.source, o.placement, a.system_key,
              o.awarded_by::text, o.note, r.id AS recipient_id,
              r.player_steam_id::text, r.tournament_team_id,
              r.revoked_at, r.revoked_by::text, r.revocation_reason
         FROM award_occurrences o
         INNER JOIN awards a ON a.id = o.award_id
         INNER JOIN award_recipients r ON r.occurrence_id = o.id
        WHERE o.tournament_id = $1 AND o.placement = 0
        ORDER BY o.created_at, r.created_at`,
      [tournamentId],
    );

  const activeMvp = async (tournamentId: string) =>
    (await mvpRows(tournamentId)).filter((r) => r.revoked_at === null);

  const choose = (
    s: Setup,
    player: string,
    actor = s.organizer,
    note?: string,
  ) =>
    postgres.query("SELECT public.set_tournament_mvp($1, $2, $3, $4)", [
      s.id,
      player,
      actor,
      note ?? null,
    ]);

  describe("no automatic MVP", () => {
    it("finishing a 5v5 tournament awards no MVP, and recalculation does not either", async () => {
      const t = await tournaments.launch(stages, 4, "Competitive");
      const [stageId] = t.stageIds;
      for (let round = 1; round <= 3; round++) {
        const bracket = await postgres.query<
          Array<{ match_id: string; l1: string; l2: string }>
        >(
          `SELECT tb.match_id, m.lineup_1_id AS l1, m.lineup_2_id AS l2
             FROM tournament_brackets tb JOIN matches m ON m.id = tb.match_id
            WHERE tb.tournament_stage_id = $1 AND tb.round = $2
              AND tb.match_id IS NOT NULL AND tb.finished = false`,
          [stageId, round],
        );
        for (const b of bracket) {
          const [map] = await postgres.query<Array<{ id: string }>>(
            `INSERT INTO match_maps (match_id, map_id, "order")
             SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
            [b.match_id],
          );
          const one = await seats(b.l1);
          const two = await seats(b.l2);
          for (let i = 0; i < 5; i++) {
            await fx.kill(
              { matchId: b.match_id, mapId: map.id },
              one[i],
              two[i],
            );
            await fx.kill(
              { matchId: b.match_id, mapId: map.id },
              two[i],
              one[i],
            );
          }
          await tournaments.winMatch(b.match_id);
          await postgres.query("SELECT generate_player_elo_for_match($1)", [
            b.match_id,
          ]);
        }
      }

      expect(await tournaments.tournamentStatus(t.id)).toBe("Finished");
      const [elo] = await postgres.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM player_elo",
      );
      expect(elo.count).toBeGreaterThan(0);

      const placements = async () =>
        (
          await postgres.query<Array<{ placement: number }>>(
            "SELECT placement FROM award_occurrences WHERE tournament_id = $1 ORDER BY placement",
            [t.id],
          )
        ).map((r) => r.placement);
      // Champion, runner-up and third place are still calculated; MVP is not.
      expect(await placements()).not.toContain(0);
      expect((await placements()).length).toBeGreaterThan(0);

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);
      await postgres.query("SELECT recalculate_tournament_awards($1)", [t.id]);
      expect(await placements()).not.toContain(0);
    }, 120_000);
  });

  describe("choosing the MVP", () => {
    it("a finished 5v5 tournament takes a manual MVP, stored as placement 0 with who chose it", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const player = s.seats1[0];

      await choose(s, player, s.organizer, "Carried the final");

      const [row] = await activeMvp(s.id);
      expect(row.source).toBe("manual");
      expect(row.placement).toBe(0);
      expect(row.system_key).toBe("tournament_mvp");
      expect(row.player_steam_id).toBe(player);
      expect(row.awarded_by).toBe(s.organizer);
      expect(row.note).toBe("Carried the final");
      expect(row.tournament_team_id).toBe(
        s.teams.find((t) => t.ttId === row.tournament_team_id)?.ttId,
      );
    });

    it("records the tournament team the player actually played for", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const [bracket] = await postgres.query<Array<{ a: string; b: string }>>(
        "SELECT tournament_team_id_1 AS a, tournament_team_id_2 AS b FROM tournament_brackets WHERE match_id = $1",
        [s.matchId],
      );

      await choose(s, s.seats1[0]);
      await choose(s, s.seats2[0]);

      const rows = await mvpRows(s.id);
      expect(rows[0].tournament_team_id).toBe(bracket.a);
      expect(rows[1].tournament_team_id).toBe(bracket.b);
    });

    it("a non-5v5 tournament cannot receive a tournament MVP", async () => {
      const s = await setup({ type: "Wingman", mates: 1 });
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await expect(choose(s, s.seats1[0])).rejects.toThrow(
        /only awarded in 5v5/i,
      );
      expect(await mvpRows(s.id)).toHaveLength(0);
    });

    it("a tournament that has not finished cannot receive an MVP", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await expect(choose(s, s.seats1[0])).rejects.toThrow(
        /once the tournament has finished/i,
      );
      expect(await mvpRows(s.id)).toHaveLength(0);
    });

    it("a tournament with awards disabled cannot receive an MVP", async () => {
      const s = await setup({ awards: false });
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await expect(choose(s, s.seats1[0])).rejects.toThrow(
        /Awards are not enabled/i,
      );
    });

    it("a player who took part is allowed", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await expect(choose(s, s.seats2[3])).resolves.toBeDefined();
      expect((await activeMvp(s.id))[0].player_steam_id).toBe(s.seats2[3]);
    });

    it("a player who was only seated and never played is rejected", async () => {
      const s = await setup({ subs: 2, mates: 5 });
      expect(s.seats1).toHaveLength(6);
      const starters = s.seats1.slice(0, 5);
      const idle = s.seats1[5];
      await play(s, starters, s.seats2);
      await markFinished(s.id);

      await expect(choose(s, idle)).rejects.toThrow(/did not play/i);
      expect(await mvpRows(s.id)).toHaveLength(0);
    });

    it("a substitute who actually played is allowed, with no special rule", async () => {
      const s = await setup({ subs: 2, mates: 5 });
      const substitute = s.seats1[5];
      await play(s, [...s.seats1.slice(0, 4), substitute], s.seats2);
      await markFinished(s.id);

      await expect(choose(s, substitute)).resolves.toBeDefined();
      expect((await activeMvp(s.id))[0].player_steam_id).toBe(substitute);
    });

    it("a player from a different tournament is rejected", async () => {
      const a = await setup();
      const b = await setup();
      await play(a, a.seats1, a.seats2);
      await play(b, b.seats1, b.seats2);
      await markFinished(a.id);
      await expect(choose(a, b.seats1[0])).rejects.toThrow(/did not play/i);
    });
  });

  describe("changing and clearing", () => {
    it("changing the MVP leaves exactly one active MVP and keeps the history", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const admin = await fx.player();

      await choose(s, s.seats1[0], s.organizer);
      await choose(s, s.seats2[0], admin, "Reconsidered");

      const rows = await mvpRows(s.id);
      expect(rows).toHaveLength(2);
      const active = rows.filter((r) => r.revoked_at === null);
      expect(active).toHaveLength(1);
      expect(active[0].player_steam_id).toBe(s.seats2[0]);
      expect(active[0].awarded_by).toBe(admin);

      const old = rows.find((r) => r.revoked_at !== null)!;
      expect(old.player_steam_id).toBe(s.seats1[0]);
      expect(old.revoked_by).toBe(admin);
      expect(old.revocation_reason).toBe("MVP changed: Reconsidered");
    });

    it("choosing the player who already holds it changes nothing", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await choose(s, s.seats1[0]);
      await choose(s, s.seats1[0]);
      expect(await mvpRows(s.id)).toHaveLength(1);
    });

    it("clearing removes the active MVP, records who and why, and can be redone", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await choose(s, s.seats1[0]);

      await postgres.query("SELECT public.clear_tournament_mvp($1, $2, $3)", [
        s.id,
        s.organizer,
        "Wrong player",
      ]);

      expect(await activeMvp(s.id)).toHaveLength(0);
      const [row] = await mvpRows(s.id);
      expect(row.revoked_by).toBe(s.organizer);
      expect(row.revocation_reason).toBe("MVP cleared: Wrong player");
      await expect(
        postgres.query("SELECT public.clear_tournament_mvp($1, $2)", [
          s.id,
          s.organizer,
        ]),
      ).rejects.toThrow(/no MVP to clear/i);

      await choose(s, s.seats2[0]);
      expect(await activeMvp(s.id)).toHaveLength(1);
    });
  });

  describe("history", () => {
    it("removing the player from the tournament roster later does not change the MVP", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await choose(s, s.seats1[0]);
      const before = (await activeMvp(s.id))[0];

      await postgres.query(
        "ALTER TABLE tournament_team_roster DISABLE TRIGGER USER",
      );
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
        [s.id, s.seats1[0]],
      );
      await postgres.query(
        "ALTER TABLE tournament_team_roster ENABLE TRIGGER USER",
      );

      const after = (await activeMvp(s.id))[0];
      expect(after.player_steam_id).toBe(before.player_steam_id);
      expect(after.tournament_team_id).toBe(before.tournament_team_id);
      expect(after.recipient_id).toBe(before.recipient_id);
    });

    it("award recalculation preserves a manual MVP", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await choose(s, s.seats1[0]);
      const before = (await activeMvp(s.id))[0];

      await postgres.query("SELECT calculate_tournament_awards($1)", [s.id]);
      await postgres.query("SELECT recalculate_tournament_awards($1)", [s.id]);

      const after = await activeMvp(s.id);
      expect(after).toHaveLength(1);
      expect(after[0].recipient_id).toBe(before.recipient_id);
    });

    it("an MVP row that already exists from the old automatic calculation is left alone", async () => {
      const s = await setup();
      await markFinished(s.id);
      const [award] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM awards WHERE system_key = 'tournament_mvp'",
      );
      const player = s.seats1[0];
      const [occ] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO award_occurrences (award_id, tournament_id, placement, source, calculation_key)
         VALUES ($1, $2, 0, 'tournament_calculated', $3) RETURNING id`,
        [award.id, s.id, `tournament:${s.id}:mvp`],
      );
      await postgres.query(
        "INSERT INTO award_recipients (occurrence_id, player_steam_id, tournament_team_id) VALUES ($1, $2, $3)",
        [occ.id, player, s.teams[0].ttId],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [s.id]);
      await postgres.query("SELECT recalculate_tournament_awards($1)", [s.id]);

      const rows = await activeMvp(s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].player_steam_id).toBe(player);
      expect(rows[0].source).toBe("tournament_calculated");
    });
  });

  describe("candidates", () => {
    it("lists only players who played, by name, with guidance stats and no ranking", async () => {
      const s = await setup({ subs: 2, mates: 5 });
      const starters = s.seats1.slice(0, 5);
      await play(s, starters, s.seats2);
      await markFinished(s.id);

      const candidates = await service.listTournamentMvpCandidates(s.id);
      const ids = candidates.map((c) => c.player_steam_id);
      expect(ids).not.toContain(s.seats1[5]);
      expect(new Set(ids)).toEqual(new Set([...starters, ...s.seats2]));

      const names = candidates.map((c) => c.player_name.toLowerCase());
      expect(names).toEqual([...names].sort());

      const row = candidates[0];
      expect(Object.keys(row).sort()).toEqual(
        [
          "assists",
          "deaths",
          "kills",
          "matches_played",
          "player_name",
          "player_steam_id",
          "rating",
          "team_name",
          "tournament_team_id",
        ].sort(),
      );
      expect(row.matches_played).toBe(1);
      expect(row.tournament_team_id).not.toBeNull();
    });

    it("a seated substitute appears once they play", async () => {
      const s = await setup({ subs: 2, mates: 5 });
      await play(s, s.seats1.slice(0, 5), s.seats2);
      await markFinished(s.id);
      expect(
        (await service.listTournamentMvpCandidates(s.id)).map(
          (c) => c.player_steam_id,
        ),
      ).not.toContain(s.seats1[5]);

      await fx.kill(
        { matchId: s.matchId, mapId: s.mapId },
        s.seats1[5],
        s.seats2[0],
      );

      expect(
        (await service.listTournamentMvpCandidates(s.id)).map(
          (c) => c.player_steam_id,
        ),
      ).toContain(s.seats1[5]);
    });
  });

  describe("who may choose, change or clear it", () => {
    const asUser = (steam_id: string, role: string) =>
      ({ steam_id, role }) as never;

    it("the tournament organizer is allowed", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
          user: asUser(s.organizer, "verified_user"),
        }),
      ).resolves.toEqual({ success: true });
      await expect(
        controller.clearTournamentMvp({
          tournament_id: s.id,
          user: asUser(s.organizer, "verified_user"),
        }),
      ).resolves.toEqual({ success: true });
    });

    it("a co-organizer is allowed", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const coOrganizer = await fx.player();
      await postgres.query(
        "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
        [s.id, coOrganizer],
      );
      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
          user: asUser(coOrganizer, "verified_user"),
        }),
      ).resolves.toEqual({ success: true });
      expect((await activeMvp(s.id))[0].awarded_by).toBe(coOrganizer);
    });

    it("a site administrator is allowed", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const admin = await fx.player();
      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
          user: asUser(admin, "administrator"),
        }),
      ).resolves.toEqual({ success: true });
    });

    it.each([
      ["a moderator", "moderator"],
      [
        "a site-wide organizer who does not organize this tournament",
        "tournament_organizer",
      ],
      ["a match organizer", "match_organizer"],
      ["an ordinary user", "user"],
    ])("%s is denied", async (_name, role) => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const outsider = await fx.player();
      const user = asUser(outsider, role);

      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
          user,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.clearTournamentMvp({ tournament_id: s.id, user }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.tournamentMvpCandidates({ tournament_id: s.id, user }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await mvpRows(s.id)).toHaveLength(0);
    });

    it("the owner, admin and captain of a participating team are denied just for managing it", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      const [manager] = s.teams;
      const [captain] = await postgres.query<
        Array<{ captain_steam_id: string }>
      >("SELECT captain_steam_id::text FROM tournament_teams WHERE id = $1", [
        manager.ttId,
      ]);
      for (const steam of [manager.owner, captain.captain_steam_id]) {
        await expect(
          controller.setTournamentMvp({
            tournament_id: s.id,
            player_steam_id: s.seats1[0],
            user: asUser(steam, "verified_user"),
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(await mvpRows(s.id)).toHaveLength(0);
    });

    it("an anonymous caller is denied", async () => {
      const s = await setup();
      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rule violations reach the caller as a plain message", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await expect(
        controller.setTournamentMvp({
          tournament_id: s.id,
          player_steam_id: s.seats1[0],
          user: asUser(s.organizer, "verified_user"),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("the results page", () => {
    it("reads the manual MVP as the placement 0 occurrence of the tournament", async () => {
      const s = await setup();
      await play(s, s.seats1, s.seats2);
      await markFinished(s.id);
      await choose(s, s.seats1[0]);

      const rows = await postgres.query<
        Array<{ placement: number; count: number }>
      >(
        `SELECT o.placement, count(r.id)::int AS count
           FROM award_occurrences o
           LEFT JOIN award_recipients r ON r.occurrence_id = o.id AND r.revoked_at IS NULL
          WHERE o.tournament_id = $1 AND o.placement = 0
          GROUP BY o.placement`,
        [s.id],
      );
      expect(rows).toEqual([{ placement: 0, count: 1 }]);
    });
  });
});
