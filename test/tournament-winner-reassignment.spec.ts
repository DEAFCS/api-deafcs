import fs from "fs";
import path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Bug A: reassigning a tournament match's winner through the simple selector
// used to leave a downstream, already-scheduled match's match_lineups/
// match_lineup_players pointing at the displaced team ("bracket says L,
// player list still says Theft"). The fix is two-layered:
//
//  - SQL: refresh_tournament_match_lineup_teams (hasura/functions/tournaments)
//    is now invoked from tau_tournament_brackets whenever an *existing*
//    downstream match's bracket slot changes teams, and it re-derives
//    match_lineups.team_id + match_lineup_players from the newly assigned
//    tournament_team_roster -- but only while that downstream match is still
//    Scheduled/WaitingForCheckIn/Canceled. A Live/Finished match is left
//    untouched; that's what reset_tournament_match (Bug B's neighbor, see
//    tournament-reset.spec.ts) is for.
//  - Node: matches.controller#setMatchWinner (unchanged by this fix) already
//    refuses a reassignment whenever can_reassign_winner is false, which is
//    exactly the case where a downstream match has progressed past that same
//    safe-status set. This suite proves that gate's SQL semantics directly;
//    the web-side switch away from the raw update_matches_by_pk bypass is
//    covered by test/match-select-winner.test.mjs in deafcs-web.
describe("tournament winner reassignment (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentWinnerReassignmentTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199500000000n);
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
  });

  const SE4 = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }];

  const rosterOf = (tournamentTeamId: string) =>
    postgres
      .query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM tournament_team_roster WHERE tournament_team_id = $1",
        [tournamentTeamId],
      )
      .then((rows) => rows.map((r) => r.player_steam_id).sort());

  const lineupPlayers = (lineupId: string) =>
    postgres
      .query<Array<{ steam_id: string }>>(
        "SELECT steam_id FROM match_lineup_players WHERE match_lineup_id = $1",
        [lineupId],
      )
      .then((rows) => rows.map((r) => r.steam_id).sort());

  // Plays out both semifinals (lineup 1 wins each, matching TournamentFixtures'
  // default), leaving an unplayed, fully-scheduled final -- the exact "safe"
  // downstream shape Bug A must handle.
  const semisToUnplayedFinal = async (matchType: string) => {
    const t = await tfx.launch(SE4, 4, matchType);
    await tfx.playRound(t.stageIds[0], 1);
    const brackets = await tfx.getBrackets(t.stageIds[0]);
    const semi1 = brackets.find((b) => b.round === 1 && b.match_number === 1)!;
    const semi2 = brackets.find((b) => b.round === 1 && b.match_number === 2)!;
    const final = brackets.find((b) => b.round === 2)!;
    return { t, semi1, semi2, final };
  };

  it.each([["Wingman"], ["Duel"], ["Competitive"]])(
    "%s: reassigning a semifinal winner rewrites the final's bracket slot, match_lineups.team_id, and match_lineup_players together",
    async (matchType) => {
      const { semi1, final } = await semisToUnplayedFinal(matchType);

      // winMatch() defaults to lineup_1_id, so tournament_team_id_1 is the
      // semifinal's current (soon to be displaced) winner.
      const displacedTeam = semi1.tournament_team_id_1!;
      const incomingTeam = semi1.tournament_team_id_2!;

      const [beforeRow] = await postgres.query<
        Array<{
          tournament_team_id_1: string | null;
          tournament_team_id_2: string | null;
          match_id: string;
        }>
      >("SELECT tournament_team_id_1, tournament_team_id_2, match_id FROM tournament_brackets WHERE id = $1", [
        final.id,
      ]);
      const displacedSlot =
        beforeRow.tournament_team_id_1 === displacedTeam ? "lineup_1_id" : "lineup_2_id";

      const [finalMatch] = await postgres.query<
        Array<{ lineup_1_id: string; lineup_2_id: string; status: string }>
      >("SELECT lineup_1_id, lineup_2_id, status FROM matches WHERE id = $1", [beforeRow.match_id]);
      expect(["Scheduled", "WaitingForCheckIn"]).toContain(finalMatch.status);

      const displacedLineupId =
        displacedSlot === "lineup_1_id" ? finalMatch.lineup_1_id : finalMatch.lineup_2_id;

      // Sanity check: before reassignment, the final's lineup for that slot
      // really does hold the displaced team's roster.
      expect(await lineupPlayers(displacedLineupId)).toEqual(await rosterOf(displacedTeam));

      // Reassign the semifinal's winner to the other lineup -- same raw
      // winning_lineup_id UPDATE the (fixed) web action and the old buggy
      // path both ultimately issue; the trigger cascade doesn't care who
      // issued it.
      await tfx.winMatch(semi1.match_id!, "lineup_2_id");

      const [afterRow] = await postgres.query<
        Array<{ tournament_team_id_1: string | null; tournament_team_id_2: string | null }>
      >("SELECT tournament_team_id_1, tournament_team_id_2 FROM tournament_brackets WHERE id = $1", [
        final.id,
      ]);
      const newSlotTeam =
        displacedSlot === "lineup_1_id" ? afterRow.tournament_team_id_1 : afterRow.tournament_team_id_2;
      expect(newSlotTeam).toBe(incomingTeam);

      const [{ team_id: lineupTeamId }] = await postgres.query<Array<{ team_id: string | null }>>(
        "SELECT team_id FROM match_lineups WHERE id = $1",
        [displacedLineupId],
      );
      const [{ team_id: incomingPersistentTeamId }] = await postgres.query<
        Array<{ team_id: string | null }>
      >("SELECT team_id FROM tournament_teams WHERE id = $1", [incomingTeam]);
      expect(lineupTeamId).toBe(incomingPersistentTeamId);

      const incomingRoster = await rosterOf(incomingTeam);
      const displacedRoster = await rosterOf(displacedTeam);
      const playersAfter = await lineupPlayers(displacedLineupId);

      expect(playersAfter).toEqual(incomingRoster);
      for (const steamId of displacedRoster) {
        if (!incomingRoster.includes(steamId)) {
          expect(playersAfter).not.toContain(steamId);
        }
      }
    },
  );

  // Production observed "Cannot remove players: not enough players in
  // lineup" the moment a tournament winner was reassigned through the fixed
  // web selector -- meaning match_lineup_players' minimum-roster DELETE
  // guard (hasura/triggers/match_lineup_players.sql, tbid_match_lineup_players)
  // really does see a non-admin hasura.user session while this cascade runs,
  // whatever the exact plumbing from setMatchWinner's admin-secret-authenticated
  // Hasura mutation turns out to be. These tests don't depend on resolving
  // that mechanism: they reproduce the guard under an explicit, realistic
  // organizer session (runAsUser, the same helper permissions.spec.ts uses to
  // simulate how Hasura forwards x-hasura-* as the `hasura.user` Postgres
  // session variable) and prove the fix survives it regardless.
  it("reproduces the production guard: naively deleting a lineup's players under a real organizer session hits 'Cannot remove players'", async () => {
    const { t, final } = await semisToUnplayedFinal("Duel");
    const [{ match_id: finalMatchId }] = await postgres.query<Array<{ match_id: string }>>(
      "SELECT match_id FROM tournament_brackets WHERE id = $1",
      [final.id],
    );
    const [{ lineup_1_id: lineupId }] = await postgres.query<Array<{ lineup_1_id: string }>>(
      "SELECT lineup_1_id FROM matches WHERE id = $1",
      [finalMatchId],
    );

    await expect(
      runAsUser(postgres, t.organizer, "tournament_organizer", (query) =>
        query("DELETE FROM match_lineup_players WHERE match_lineup_id = $1", [lineupId]),
      ),
    ).rejects.toThrow(/Cannot remove players: not enough players in lineup/);
  });

  it.each([["Wingman"], ["Duel"], ["Competitive"]])(
    "%s: the fix succeeds under a real (non-admin) organizer session, not just an unauthenticated test connection",
    async (matchType) => {
      const { t, semi1, final } = await semisToUnplayedFinal(matchType);
      const incomingTeam = semi1.tournament_team_id_2!;

      const [beforeRow] = await postgres.query<
        Array<{ tournament_team_id_1: string | null; match_id: string }>
      >("SELECT tournament_team_id_1, match_id FROM tournament_brackets WHERE id = $1", [final.id]);
      const [finalMatch] = await postgres.query<Array<{ lineup_1_id: string; lineup_2_id: string }>>(
        "SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1",
        [beforeRow.match_id],
      );
      const displacedLineupId =
        beforeRow.tournament_team_id_1 === semi1.tournament_team_id_1
          ? finalMatch.lineup_1_id
          : finalMatch.lineup_2_id;

      await runAsUser(postgres, t.organizer, "tournament_organizer", (query) =>
        query("UPDATE matches SET winning_lineup_id = lineup_2_id WHERE id = $1", [semi1.match_id]),
      );

      expect(await lineupPlayers(displacedLineupId)).toEqual(await rosterOf(incomingTeam));
    },
  );

  it("never rewrites a downstream match's lineups once it has actually been played", async () => {
    const { semi1, final } = await semisToUnplayedFinal("Wingman");

    const [beforeRow] = await postgres.query<
      Array<{ tournament_team_id_1: string | null; tournament_team_id_2: string | null; match_id: string }>
    >("SELECT tournament_team_id_1, tournament_team_id_2, match_id FROM tournament_brackets WHERE id = $1", [
      final.id,
    ]);

    // Play the final out for real (same path playedOutCup() uses in
    // tournament-reset.spec.ts) so it reaches Finished through production
    // triggers rather than an artificial status jump.
    await tfx.winMatch(beforeRow.match_id);

    const [finalMatch] = await postgres.query<Array<{ lineup_1_id: string; lineup_2_id: string }>>(
      "SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1",
      [beforeRow.match_id],
    );
    const beforePlayers1 = await lineupPlayers(finalMatch.lineup_1_id);
    const beforePlayers2 = await lineupPlayers(finalMatch.lineup_2_id);
    const beforeTeamIds = await postgres.query<Array<{ id: string; team_id: string | null }>>(
      "SELECT id, team_id FROM match_lineups WHERE id = ANY($1)",
      [[finalMatch.lineup_1_id, finalMatch.lineup_2_id]],
    );

    // assign_team_to_bracket_slot itself is untouched by this fix (in
    // production the Node-side canReassignWinner guard, proven separately
    // below, is what stops this raw update from ever being issued once a
    // downstream match is Finished) -- so the bracket slot can still move
    // here. What refresh_tournament_match_lineup_teams must guarantee
    // regardless is that it never patches an already-played match's
    // lineups in place.
    await tfx.winMatch(semi1.match_id!, "lineup_2_id");

    expect(await lineupPlayers(finalMatch.lineup_1_id)).toEqual(beforePlayers1);
    expect(await lineupPlayers(finalMatch.lineup_2_id)).toEqual(beforePlayers2);

    const afterTeamIds = await postgres.query<Array<{ id: string; team_id: string | null }>>(
      "SELECT id, team_id FROM match_lineups WHERE id = ANY($1)",
      [[finalMatch.lineup_1_id, finalMatch.lineup_2_id]],
    );
    expect(afterTeamIds).toEqual(beforeTeamIds);
  });

  it("can_reassign_winner rejects a semifinal reassignment once the final has actually been played", async () => {
    const { t, semi1, final } = await semisToUnplayedFinal("Wingman");
    const [beforeRow] = await postgres.query<Array<{ match_id: string }>>(
      "SELECT match_id FROM tournament_brackets WHERE id = $1",
      [final.id],
    );

    const organizerSession = JSON.stringify({
      "x-hasura-role": "tournament_organizer",
      "x-hasura-user-id": t.organizer,
    });

    const [{ allowed: allowedWhileUnplayed }] = await postgres.query<Array<{ allowed: boolean }>>(
      "SELECT can_reassign_winner(m, $2::json) AS allowed FROM matches m WHERE m.id = $1",
      [semi1.match_id, organizerSession],
    );
    expect(allowedWhileUnplayed).toBe(true);

    // Play the final out for real, same as playedOutCup() in tournament-reset.spec.ts.
    await tfx.winMatch(beforeRow.match_id);

    const [{ allowed: allowedWhileFinished }] = await postgres.query<Array<{ allowed: boolean }>>(
      "SELECT can_reassign_winner(m, $2::json) AS allowed FROM matches m WHERE m.id = $1",
      [semi1.match_id, organizerSession],
    );
    expect(allowedWhileFinished).toBe(false);
  });

  // setMatchWinner (src/matches/matches.controller.ts) can't be exercised
  // end-to-end here: it calls out to a live Hasura GraphQL engine
  // (HasuraService#query/#mutation), which this Postgres-only test harness
  // doesn't boot. The gate it depends on (can_reassign_winner) is proven
  // directly above; this asserts the Node-side wiring to that gate -- the
  // reject-before-mutate guard -- wasn't touched or weakened by this fix.
  it("matches.controller.setMatchWinner still checks canReassignWinner and throws before mutating on a blocked reassignment", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/matches/matches.controller.ts"),
      "utf8",
    );
    const start = source.indexOf("public async setMatchWinner(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("public async setMapWinner("));

    expect(body).toMatch(/isReassignment\s*=\s*\n?\s*current\.winning_lineup_id != null/);
    expect(body).toMatch(/canReassignWinner\(match_id, user\)/);
    expect(body).toMatch(/throw Error\(\s*\n?\s*"cannot change winner/);

    const throwIdx = body.indexOf("cannot change winner");
    const mutateIdx = body.indexOf("update_matches_by_pk");
    expect(throwIdx).toBeGreaterThan(-1);
    expect(mutateIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeLessThan(mutateIdx);
  });

  // Scope check: MatchSelectWinner.vue / setMatchWinner are shared by every
  // match source (MatchActions.vue's canSetMatchWinner only checks
  // is_organizer + role, no source/type gate -- see pages/matches/[id]/index.vue,
  // the one shared match-detail page). refresh_tournament_match_lineup_teams
  // is only ever invoked from tau_tournament_brackets (an AFTER UPDATE
  // trigger on tournament_brackets), and can_reassign_winner's downstream
  // check only bites when a tournament_brackets row exists for the match.
  // Neither an ordinary matchmaking/manual match nor a draft match ever gets
  // a tournament_brackets row, so both must behave exactly as before this
  // fix: unrestricted winner (re)selection, no lineup-refresh side effects.
  //
  // League matches are the one case that's intentionally NOT exempt here:
  // hasura/triggers/league_match_lineup_players.sql shows a league match is
  // still a tournament_stages/tournament_brackets row underneath (joined via
  // league_season_divisions), so the tournament safeguards above already
  // cover League by the same mechanism -- nothing additional to carve out.
  describe("non-tournament matches are unaffected", () => {
    const buildOrdinaryMatch = async (matchType: string) => {
      const organizer = await fx.player();
      const match = await fx.match({ type: matchType });
      await postgres.query("UPDATE matches SET organizer_steam_id = $1 WHERE id = $2", [
        organizer,
        match.id,
      ]);
      const teammates = matchType === "Duel" ? 0 : matchType === "Wingman" ? 1 : 4;
      const lineup1Players = [
        await fx.lineupPlayer(match.lineup_1_id),
        ...(await Promise.all(
          Array.from({ length: teammates }, () => fx.lineupPlayer(match.lineup_1_id)),
        )),
      ];
      const lineup2Players = [
        await fx.lineupPlayer(match.lineup_2_id),
        ...(await Promise.all(
          Array.from({ length: teammates }, () => fx.lineupPlayer(match.lineup_2_id)),
        )),
      ];
      return { organizer, match, lineup1Players, lineup2Players };
    };

    it.each([["Wingman"], ["Duel"], ["Competitive"]])(
      "%s ordinary/matchmaking-style match: first winner selection and reassignment both work exactly as before, untouched by tournament safeguards",
      async (matchType) => {
        const { organizer, match } = await buildOrdinaryMatch(matchType);
        const before1 = await lineupPlayers(match.lineup_1_id);
        const before2 = await lineupPlayers(match.lineup_2_id);

        expect(
          (
            await postgres.query<Array<{ id: string | null }>>(
              "SELECT tb.id FROM tournament_brackets tb WHERE tb.match_id = $1",
              [match.id],
            )
          ).length,
        ).toBe(0);

        const organizerSession = JSON.stringify({
          "x-hasura-role": "match_organizer",
          "x-hasura-user-id": organizer,
        });

        // First winner selection: no prior winner, so canReassignWinner is
        // never even consulted (matches.controller#setMatchWinner only calls
        // it when isReassignment is true).
        await postgres.query("UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1", [
          match.id,
        ]);

        // Reassignment of an ordinary match: no tournament_brackets row
        // exists, so can_reassign_winner's downstream check is a no-op and
        // this must be allowed exactly as it always was.
        const [{ allowed }] = await postgres.query<Array<{ allowed: boolean }>>(
          "SELECT can_reassign_winner(m, $2::json) AS allowed FROM matches m WHERE m.id = $1",
          [match.id, organizerSession],
        );
        expect(allowed).toBe(true);

        await postgres.query("UPDATE matches SET winning_lineup_id = lineup_2_id WHERE id = $1", [
          match.id,
        ]);

        const [{ winning_lineup_id: winner, lineup_2_id: lineup2 }] = await postgres.query<
          Array<{ winning_lineup_id: string; lineup_2_id: string }>
        >("SELECT winning_lineup_id, lineup_2_id FROM matches WHERE id = $1", [match.id]);
        expect(winner).toBe(lineup2);

        // No tournament lineup-refresh path was ever involved: the exact
        // same players are seated, same rows, nothing added or removed.
        expect(await lineupPlayers(match.lineup_1_id)).toEqual(before1);
        expect(await lineupPlayers(match.lineup_2_id)).toEqual(before2);
      },
    );

    it("draft match (matches row linked via draft_games.match_id, no tournament_brackets row): winner reassignment is unaffected", async () => {
      const { organizer, match } = await buildOrdinaryMatch("Wingman");
      await postgres.query(
        `INSERT INTO draft_games (host_steam_id, type, status, capacity, match_id)
         VALUES ($1, 'Wingman', 'Completed', 4, $2)`,
        [organizer, match.id],
      );
      const before1 = await lineupPlayers(match.lineup_1_id);
      const before2 = await lineupPlayers(match.lineup_2_id);

      await postgres.query("UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1", [
        match.id,
      ]);
      await postgres.query("UPDATE matches SET winning_lineup_id = lineup_2_id WHERE id = $1", [
        match.id,
      ]);

      const [{ winning_lineup_id: winner, lineup_2_id: lineup2 }] = await postgres.query<
        Array<{ winning_lineup_id: string; lineup_2_id: string }>
      >("SELECT winning_lineup_id, lineup_2_id FROM matches WHERE id = $1", [match.id]);
      expect(winner).toBe(lineup2);
      expect(await lineupPlayers(match.lineup_1_id)).toEqual(before1);
      expect(await lineupPlayers(match.lineup_2_id)).toEqual(before2);
    });
  });
});
