import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Winner, runner-up and third place go to the players who actually took part
// in the tournament, not to everyone on the roster. A substitute who was only
// registered or seated never played and gets no placement award; one who
// plays a single match does (by being put into the starting lineup, which is
// the only way into a match). Team recipients, the manual tournament MVP and
// every non-tournament award are not affected.
describe("tournament placement awards go to players who took part (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentPlacementParticipationTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199995000000n);
    tournaments = new TournamentFixtures(postgres, fx);
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

  const seats = async (lineupId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      )
    ).map((r) => r.steam_id);

  type Cup = { id: string; stageId: string };

  // Four teams of seven (five starters plus two substitutes), a single
  // elimination bracket with a third-place match. A match seats the five
  // starting players only, so the two substitutes of each team are never in a
  // match unless `extraPlayer` puts one into a starting lineup.
  const playCup = async ({
    withEvents = true,
    extraPlayer,
  }: {
    withEvents?: boolean;
    // A substitute who takes part in exactly one match: [round, matchNumber].
    extraPlayer?: { round: number; matchNumber: number };
  } = {}): Promise<Cup & { idle: Set<string>; sub: string | null }> => {
    const t = await tournaments.createTournament(
      [
        {
          type: "SingleElimination",
          order: 1,
          minTeams: 4,
          maxTeams: 4,
          thirdPlaceMatch: true,
        },
      ],
      "Competitive",
    );
    await postgres.query(
      `UPDATE match_options SET number_of_substitutes = 2
        WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tournaments.registerTeam(t.id, await fx.team(6));
    }
    await tournaments.setStatus(t.id, t.organizer, "RegistrationClosed");
    await tournaments.setStatus(t.id, t.organizer, "Live");

    const everSeated = new Set<string>();
    let sub: string | null = null;
    const stageId = t.stageIds[0];

    for (let round = 1; round <= 2; round++) {
      const brackets = await postgres.query<
        Array<{
          match_id: string;
          l1: string;
          l2: string;
          match_number: number;
        }>
      >(
        `SELECT tb.match_id, m.lineup_1_id AS l1, m.lineup_2_id AS l2, tb.match_number
           FROM tournament_brackets tb JOIN matches m ON m.id = tb.match_id
          WHERE tb.tournament_stage_id = $1 AND tb.round = $2
            AND tb.match_id IS NOT NULL AND tb.finished = false
          ORDER BY tb.match_number`,
        [stageId, round],
      );
      for (const b of brackets) {
        let one = await seats(b.l1);
        const two = await seats(b.l2);
        expect(one).toHaveLength(5);
        expect(two).toHaveLength(5);

        let swappedIn: string | null = null;
        if (
          extraPlayer &&
          extraPlayer.round === round &&
          extraPlayer.matchNumber === b.match_number
        ) {
          // A substitute is put into the starting lineup in place of a
          // starter who is not the captain.
          const [bench] = await postgres.query<Array<{ steam_id: string }>>(
            `SELECT ttr.player_steam_id::text AS steam_id
               FROM tournament_team_roster ttr
              WHERE ttr.tournament_team_id = public.tournament_match_lineup_team($1)
                AND ttr.player_steam_id::text <> ALL($2::text[])
              ORDER BY ttr.player_steam_id LIMIT 1`,
            [b.l1, one],
          );
          const [dropped] = await postgres.query<Array<{ steam_id: string }>>(
            `SELECT steam_id::text FROM match_lineup_players
              WHERE match_lineup_id = $1 AND captain = false
              ORDER BY steam_id DESC LIMIT 1`,
            [b.l1],
          );
          swappedIn = bench.steam_id;
          await postgres.query(
            "SELECT set_match_starting_lineup($1, $2, $3::bigint[], $4::json)",
            [
              b.match_id,
              b.l1,
              one.filter((s) => s !== dropped.steam_id).concat(swappedIn),
              JSON.stringify({
                "x-hasura-role": "administrator",
                "x-hasura-user-id": t.organizer,
              }),
            ],
          );
          one = await seats(b.l1);
          expect(one).toContain(swappedIn);
          expect(one).toHaveLength(5);
        }
        one.forEach((s) => everSeated.add(s));
        two.forEach((s) => everSeated.add(s));
        const activeOne = one;
        const activeTwo = two;

        if (withEvents) {
          const [map] = await postgres.query<Array<{ id: string }>>(
            `INSERT INTO match_maps (match_id, map_id, "order")
             SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
            [b.match_id],
          );
          const ctx = { matchId: b.match_id, mapId: map.id };
          for (let i = 0; i < 5; i++) {
            await fx.kill(ctx, activeOne[i], activeTwo[i]);
            await fx.kill(ctx, activeTwo[i], activeOne[i]);
          }
          if (swappedIn) {
            sub = swappedIn;
          }
        }
        await tournaments.winMatch(b.match_id);
      }
    }
    expect(await tournaments.tournamentStatus(t.id)).toBe("Finished");
    const rostered = await postgres.query<Array<{ steam_id: string }>>(
      "SELECT player_steam_id::text AS steam_id FROM tournament_team_roster WHERE tournament_id = $1",
      [t.id],
    );
    const idle = new Set(
      rostered.map((r) => r.steam_id).filter((s) => !everSeated.has(s)),
    );
    expect(idle.size).toBe(sub ? 7 : 8);
    return { id: t.id, stageId, idle, sub };
  };

  const playerRecipients = async (tournamentId: string, placement: number) =>
    (
      await postgres.query<
        Array<{ player_steam_id: string; tournament_team_id: string }>
      >(
        `SELECT r.player_steam_id::text, r.tournament_team_id
           FROM award_recipients r
           JOIN award_occurrences o ON o.id = r.occurrence_id
          WHERE o.tournament_id = $1 AND o.placement = $2
            AND o.source = 'tournament_calculated'
            AND r.player_steam_id IS NOT NULL AND r.revoked_at IS NULL
          ORDER BY r.player_steam_id`,
        [tournamentId, placement],
      )
    ).map((r) => r.player_steam_id);

  const rosterOf = async (tournamentId: string, placement: number) =>
    (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT ttr.player_steam_id::text
           FROM award_recipients r
           JOIN award_occurrences o ON o.id = r.occurrence_id
           JOIN tournament_team_roster ttr ON ttr.tournament_team_id = r.tournament_team_id
          WHERE o.tournament_id = $1 AND o.placement = $2
            AND o.source = 'tournament_calculated' AND r.player_steam_id IS NULL
          ORDER BY ttr.player_steam_id`,
        [tournamentId, placement],
      )
    ).map((r) => r.player_steam_id);

  describe.each([
    [1, "Winner"],
    [2, "Runner-up"],
    [3, "Third place"],
  ])("%i: %s", (placement) => {
    it("goes to the five players who played, not to the two substitutes who only sat in the lineup", async () => {
      const cup = await playCup();
      const roster = await rosterOf(cup.id, placement);
      expect(roster).toHaveLength(7);

      const recipients = await playerRecipients(cup.id, placement);

      expect(recipients).toHaveLength(5);
      for (const idle of cup.idle) expect(recipients).not.toContain(idle);
      for (const steam of recipients) expect(roster).toContain(steam);
    });

    it("has no duplicate recipients, also after recalculating", async () => {
      const cup = await playCup();
      await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);
      await postgres.query("SELECT recalculate_tournament_awards($1)", [
        cup.id,
      ]);

      const recipients = await playerRecipients(cup.id, placement);
      expect(new Set(recipients).size).toBe(recipients.length);
      expect(recipients).toHaveLength(5);
    });
  });

  it("a substitute who plays one match gets the placement award", async () => {
    // The winner's final is round 2, match 1; a lineup-1 substitute plays it.
    const cup = await playCup({ extraPlayer: { round: 2, matchNumber: 1 } });
    expect(cup.sub).not.toBeNull();

    const [winner] = await postgres.query<
      Array<{ tournament_team_id: string }>
    >(
      `SELECT r.tournament_team_id
         FROM award_recipients r JOIN award_occurrences o ON o.id = r.occurrence_id
        WHERE o.tournament_id = $1 AND o.placement = 1 AND r.player_steam_id IS NULL`,
      [cup.id],
    );
    const [subRow] = await postgres.query<
      Array<{ tournament_team_id: string }>
    >(
      "SELECT tournament_team_id FROM tournament_team_roster WHERE tournament_id = $1 AND player_steam_id = $2",
      [cup.id, cup.sub],
    );
    // The substitute is on the final's lineup-1 team; give that team's
    // placement (winner or runner-up) its own check.
    const placement =
      subRow.tournament_team_id === winner.tournament_team_id ? 1 : 2;

    const recipients = await playerRecipients(cup.id, placement);
    expect(recipients).toContain(cup.sub);
    expect(recipients).toHaveLength(6);
  });

  it("a team that is awarded the place keeps its team recipient", async () => {
    const cup = await playCup();
    const teamRecipients = await postgres.query<Array<{ count: number }>>(
      `SELECT count(*)::int AS count
         FROM award_recipients r JOIN award_occurrences o ON o.id = r.occurrence_id
        WHERE o.tournament_id = $1 AND o.source = 'tournament_calculated'
          AND r.team_id IS NOT NULL`,
      [cup.id],
    );
    expect(teamRecipients[0].count).toBe(3);
  });

  it("when a match recorded no events at all, its seated starters stay eligible and substitutes do not", async () => {
    const cup = await playCup({ withEvents: false });
    // Lineups of five with no activity anywhere: the seats are the starters,
    // so they stand, as for ELO. The unseated substitutes are not invented.
    const winners = await playerRecipients(cup.id, 1);
    expect(winners).toHaveLength(5);
    for (const idle of cup.idle) expect(winners).not.toContain(idle);
  });

  it("never touches the manual tournament MVP", async () => {
    const cup = await playCup();
    const [candidate] = await postgres.query<
      Array<{ player_steam_id: string }>
    >("SELECT player_steam_id FROM tournament_mvp_candidates($1) LIMIT 1", [
      cup.id,
    ]);
    const [organizer] = await postgres.query<
      Array<{ organizer_steam_id: string }>
    >("SELECT organizer_steam_id::text FROM tournaments WHERE id = $1", [
      cup.id,
    ]);
    await postgres.query("SELECT public.set_tournament_mvp($1, $2, $3)", [
      cup.id,
      candidate.player_steam_id,
      organizer.organizer_steam_id,
    ]);

    await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);

    const mvp = await postgres.query<
      Array<{ player_steam_id: string; source: string }>
    >(
      `SELECT r.player_steam_id::text, o.source
         FROM award_recipients r JOIN award_occurrences o ON o.id = r.occurrence_id
        WHERE o.tournament_id = $1 AND o.placement = 0 AND r.revoked_at IS NULL`,
      [cup.id],
    );
    expect(mvp).toEqual([
      { player_steam_id: candidate.player_steam_id, source: "manual" },
    ]);
  });

  it("awards outside the tournament are not affected", async () => {
    const cup = await playCup();
    const player = await fx.player();
    const [award] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM awards WHERE system_key = 'season_mvp'",
    );
    const [occurrence] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO award_occurrences (award_id, source, note)
       VALUES ($1, 'manual', 'not a tournament award') RETURNING id`,
      [award.id],
    );
    await postgres.query(
      "INSERT INTO award_recipients (occurrence_id, player_steam_id) VALUES ($1, $2)",
      [occurrence.id, player],
    );

    await postgres.query("SELECT calculate_tournament_awards($1)", [cup.id]);

    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id::text FROM award_recipients WHERE occurrence_id = $1",
      [occurrence.id],
    );
    expect(rows).toEqual([{ player_steam_id: player }]);
  });
});
