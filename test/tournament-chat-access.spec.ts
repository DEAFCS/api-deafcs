import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

describe("tournament chat participant access", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentChatAccessTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199982000000n);
    tournaments = new TournamentFixtures(postgres, fx);
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

  const session = (steamId: string, role = "verified_user") =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

  const canSeeTournamentChat = async (
    tournamentId: string,
    steamId: string,
    role = "verified_user",
  ) => {
    const [row] = await postgres.query<Array<{ allowed: boolean | null }>>(
      `SELECT (
         joined_tournament(t, $2::json)
         OR is_tournament_organizer(t, $2::json)
       ) AS allowed
       FROM tournaments t
       WHERE id = $1`,
      [tournamentId, session(steamId, role)],
    );
    return row?.allowed === true;
  };

  const addIndividualSignup = (
    tournamentId: string,
    steamId: string,
    status: "Registered" | "Waitlisted" | "Assigned" | "Removed",
  ) =>
    postgres.query(
      `INSERT INTO tournament_individual_signups
         (tournament_id, player_steam_id, status)
       VALUES ($1, $2, $3)`,
      [tournamentId, steamId, status],
    );

  const createTournamentAtStatus = async (status: string) => {
    const organizer = await fx.player();
    const optionsId = await fx.matchOptions({ type: "Competitive" });
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments
         (name, start, organizer_steam_id, match_options_id, status, min_role)
       VALUES ($1, now() + interval '1 day', $2, $3, $4, NULL)
       RETURNING id`,
      [fx.nextName("chat-cup"), organizer, optionsId, status],
    );
    return { id: tournament.id, organizer };
  };

  it("allows the organizer but denies an unrelated verified player", async () => {
    const tournament = await tournaments.createTournament([]);
    const unrelated = await fx.player();

    expect(
      await canSeeTournamentChat(tournament.id, tournament.organizer, "user"),
    ).toBe(true);
    expect(
      await canSeeTournamentChat(tournament.id, unrelated, "administrator"),
    ).toBe(true);
    expect(await canSeeTournamentChat(tournament.id, unrelated)).toBe(false);
  });

  it.each(["Registered", "Waitlisted", "Assigned"] as const)(
    "allows an individual signup in %s state while registration is open",
    async (status) => {
      const tournament = await tournaments.createTournament([]);
      await tournaments.setStatus(
        tournament.id,
        tournament.organizer,
        "RegistrationOpen",
      );
      const player = await fx.player();
      await addIndividualSignup(tournament.id, player, status);

      expect(await canSeeTournamentChat(tournament.id, player)).toBe(true);
    },
  );

  it.each(["RegistrationOpen", "RegistrationClosed", "Live"])(
    "keeps a registered individual participant eligible while the tournament is %s",
    async (status) => {
      const tournament = await createTournamentAtStatus(status);
      const player = await fx.player();
      await addIndividualSignup(tournament.id, player, "Registered");

      expect(await canSeeTournamentChat(tournament.id, player)).toBe(true);
    },
  );

  it("revokes access after withdrawal and for a no-show Removed signup", async () => {
    const tournament = await tournaments.createTournament([]);
    await tournaments.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    const withdrawn = await fx.player();
    const removed = await fx.player();
    await addIndividualSignup(tournament.id, withdrawn, "Registered");
    await addIndividualSignup(tournament.id, removed, "Removed");

    await postgres.query(
      `DELETE FROM tournament_individual_signups
       WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournament.id, withdrawn],
    );

    expect(await canSeeTournamentChat(tournament.id, withdrawn)).toBe(false);
    expect(await canSeeTournamentChat(tournament.id, removed)).toBe(false);
  });

  it("allows every registered team roster member, including the captain", async () => {
    const tournament = await tournaments.createTournament([]);
    await tournaments.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    const team = await fx.team(4);
    await tournaments.registerTeam(tournament.id, team);
    const roster = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id
       FROM tournament_team_roster
       WHERE tournament_id = $1`,
      [tournament.id],
    );

    expect(roster.map((row) => String(row.player_steam_id))).toContain(
      team.owner,
    );
    for (const member of roster) {
      expect(
        await canSeeTournamentChat(
          tournament.id,
          String(member.player_steam_id),
        ),
      ).toBe(true);
    }
  });
});
