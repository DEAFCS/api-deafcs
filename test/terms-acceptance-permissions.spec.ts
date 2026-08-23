import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, runAsUser, SqlTestDb } from "./utils/sql-test-db";
import { TournamentFixtures } from "./utils/tournament-fixtures";

// Exercises the actual Hasura-enforced Terms-acceptance gates added to
// competitive-participation insert/update permissions, against a real
// Hasura instance bound to the repo's hasura/metadata -- same pattern as
// tournament-min-role-metadata.spec.ts / tournament-team-leave-permissions
// .spec.ts. Raw SQL bypasses Hasura's declarative check expressions
// entirely (there is no Postgres RLS backing them), so this is the only way
// to prove the YAML permission edits actually deny/allow as intended,
// rather than an accidental downstream trigger error.
describe("Terms acceptance enforcement (Hasura-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tournaments: TournamentFixtures;
  let hasura: StartedTestContainer;
  let endpoint: string;

  const ADMIN_SECRET = "terms-acceptance-test";

  beforeAll(async () => {
    db = await bootContainerAndMigrate("TermsAcceptancePermissionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
    tournaments = new TournamentFixtures(postgres, fx);

    await postgres.query(
      "INSERT INTO server_regions (value, is_lan) VALUES ('TestA', false) ON CONFLICT (value) DO NOTHING",
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
       VALUES ('127.0.0.1', 'TestA-server', '\\x00'::bytea, 27915, true, 'TestA', 'Ranked', true)
       ON CONFLICT DO NOTHING`,
    );

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.48.5.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: ADMIN_SECRET,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
      })
      .withBindMounts([
        {
          source: path.resolve("./hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();

    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  const gql = async (
    query: string,
    role: string,
    steamId?: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hasura-admin-secret": ADMIN_SECRET,
      "x-hasura-role": role,
    };
    if (steamId) headers["x-hasura-user-id"] = steamId;
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    return response.json();
  };

  // A fixture player who has explicitly NOT accepted the current Terms --
  // the negative case every test below starts from.
  const unacceptedPlayer = () => fx.player(undefined, { acceptTerms: false });

  it("has zero inconsistent metadata objects", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    const result = (await response.json()) as {
      is_consistent: boolean;
      inconsistent_objects: unknown[];
    };
    expect(result).toEqual({ is_consistent: true, inconsistent_objects: [] });
  });

  describe("teams insert", () => {
    it("denies an unaccepted player from creating a team", async () => {
      const owner = await unacceptedPlayer();
      const result = await gql(
        `mutation { insert_teams_one(object: { name: "T", short_name: "T" }) { id } }`,
        "user",
        owner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_teams_one ?? null).toBeNull();
    });

    it("allows an accepted player to create a team", async () => {
      const owner = await fx.player();
      const result = await gql(
        `mutation { insert_teams_one(object: { name: "T2", short_name: "T2" }) { id } }`,
        "user",
        owner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_teams_one?.id).toBeDefined();
    });
  });

  // team_roster.yaml's insert_permissions were investigated and left
  // UNMODIFIED (no has_accepted_current_terms added), after root-causing
  // why a Terms condition there would never be reachable:
  //
  // tbi_team_roster (hasura/triggers/team_roster.sql) is a BEFORE INSERT
  // trigger that only lets a row through when the target player IS the
  // team owner (sets role='Admin', RETURN NEW) or the session role is
  // literally 'admin'/'administrator' (RETURN NEW). For every other
  // caller -- i.e. the actual "team admin adds a normal member" case --
  // it inserts a team_invites row instead and RETURN NULLs, which makes
  // Postgres skip the INSERT entirely. Confirmed directly: even with the
  // permission's check replaced by an unconditional `check: {}` under
  // role tournament_organizer, insert_team_roster_one still resolved to
  // null, proving the null is the trigger short-circuiting the insert,
  // not Hasura's permission check evaluating false. A Terms condition on
  // this permission can therefore never gate a real row -- it would be
  // dead code, not protection, so it was not added.
  //
  // The real, live "join a team" path is components/teams/TeamMembers.vue
  // calling insert_team_roster_one directly (named onInvite -- the
  // trigger's redirect-to-team_invites behavior is exactly why that name
  // is accurate despite calling a roster-insert mutation), which lands in
  // team_invites, then InvitesController.acceptInvite's "team" branch
  // inserts the actual roster row under the admin secret (bypassing
  // declarative permissions entirely, same as the tournament-team branch).
  // acceptInvite already calls TermsService.assertAccepted at the top of
  // the handler for both branches, so real team-membership joins ARE
  // gated -- just at the Action layer, not this table's permission.

  describe("tournament registration", () => {
    const openTournament = async () => {
      const t = await tournaments.createTournament([
        { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
      ]);
      await postgres.query(
        `UPDATE match_options SET individual_registration_enabled = true
         WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id],
      );
      await tournaments.setStatus(t.id, t.organizer, "RegistrationOpen");
      return t;
    };

    it("denies individual signup for an unaccepted player", async () => {
      const t = await openTournament();
      const player = await unacceptedPlayer();
      const result = await gql(
        `mutation {
          insert_tournament_individual_signups_one(object: {
            tournament_id: "${t.id}"
            player_steam_id: "${player}"
          }) { id }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_individual_signups_one ?? null).toBeNull();
    });

    it("allows individual signup for an accepted player", async () => {
      const t = await openTournament();
      const player = await fx.player();
      const result = await gql(
        `mutation {
          insert_tournament_individual_signups_one(object: {
            tournament_id: "${t.id}"
            player_steam_id: "${player}"
          }) { id }
        }`,
        "user",
        player,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_individual_signups_one?.id).toBeDefined();
    });

    it("denies free-agent team registration for an unaccepted creator", async () => {
      const t = await openTournament();
      const owner = await unacceptedPlayer();
      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "Free Agent"
            short_name: "FA"
          }) { id }
        }`,
        "user",
        owner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_teams_one ?? null).toBeNull();
    });

    it("allows free-agent team registration for an accepted creator", async () => {
      const t = await openTournament();
      const owner = await fx.player();
      const result = await gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${t.id}"
            name: "Free Agent 2"
            short_name: "FA2"
          }) { id }
        }`,
        "user",
        owner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_tournament_teams_one?.id).toBeDefined();
    });

    // The self-accept-invite branch of tournament_team_roster insert --
    // "especially" the one the task called out. captain creates a
    // free-agent entry (auto-enrolling themselves via the roster.data
    // sub-insert), invites `invitee`, who then accepts on their own
    // session -- the exact path acceptInvite's acceptTournamentTeamInvite
    // drives in production.
    const createFreeAgentTeam = (tournamentId: string, captain: string) =>
      gql(
        `mutation {
          insert_tournament_teams_one(object: {
            tournament_id: "${tournamentId}"
            name: "Free Agents"
            short_name: "FA"
            roster: { data: [{ tournament_id: "${tournamentId}", player_steam_id: "${captain}" }] }
          }) { id }
        }`,
        "user",
        captain,
      );

    const seedInvite = (tournamentTeamId: string, steamId: string, invitedBy: string) =>
      postgres.query(
        `INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3)`,
        [tournamentTeamId, steamId, invitedBy],
      );

    it("denies an unaccepted invitee from self-accepting a tournament team invite", async () => {
      const t = await openTournament();
      const captain = await fx.player();
      const entry = await createFreeAgentTeam(t.id, captain);
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const invitee = await unacceptedPlayer();
      await seedInvite(tournamentTeamId, invitee, captain);

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(
            object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${invitee}"
            }
            on_conflict: { constraint: tournament_roster_pkey, update_columns: [role] }
          ) { player_steam_id }
        }`,
        "user",
        invitee,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_tournament_team_roster_one ?? null).toBeNull();
    });

    it("allows an accepted invitee to self-accept a tournament team invite", async () => {
      const t = await openTournament();
      const captain = await fx.player();
      const entry = await createFreeAgentTeam(t.id, captain);
      const tournamentTeamId = entry.data.insert_tournament_teams_one.id;

      const invitee = await fx.player();
      await seedInvite(tournamentTeamId, invitee, captain);

      const result = await gql(
        `mutation {
          insert_tournament_team_roster_one(
            object: {
              tournament_id: "${t.id}"
              tournament_team_id: "${tournamentTeamId}"
              player_steam_id: "${invitee}"
            }
            on_conflict: { constraint: tournament_roster_pkey, update_columns: [role] }
          ) { player_steam_id }
        }`,
        "user",
        invitee,
      );
      expect(result.errors).toBeUndefined();
      expect(
        result.data?.insert_tournament_team_roster_one?.player_steam_id,
      ).toBeDefined();
    });
  });

  describe("draft games", () => {
    it("denies an unaccepted host from creating a draft game", async () => {
      const host = await unacceptedPlayer();
      const result = await gql(
        `mutation {
          insert_draft_games_one(object: { type: Competitive }) { id }
        }`,
        "user",
        host,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_draft_games_one ?? null).toBeNull();
    });

    it("allows an accepted host to create a draft game", async () => {
      const host = await fx.player();
      const result = await gql(
        `mutation {
          insert_draft_games_one(object: { type: Competitive }) { id }
        }`,
        "user",
        host,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_draft_games_one?.id).toBeDefined();
    });

    it("denies an unaccepted player from joining an open draft game", async () => {
      const host = await fx.player();
      const created = await gql(
        `mutation { insert_draft_games_one(object: { type: Competitive }) { id } }`,
        "user",
        host,
      );
      const draftGameId = created.data.insert_draft_games_one.id;

      const joiner = await unacceptedPlayer();
      const result = await gql(
        `mutation {
          insert_draft_game_players_one(object: {
            draft_game_id: "${draftGameId}"
            steam_id: "${joiner}"
          }) { steam_id }
        }`,
        "user",
        joiner,
      );
      expect(result.errors).toBeDefined();
      expect(result.data?.insert_draft_game_players_one ?? null).toBeNull();
    });

    it("allows an accepted player to join an open draft game", async () => {
      const host = await fx.player();
      const created = await gql(
        `mutation { insert_draft_games_one(object: { type: Competitive }) { id } }`,
        "user",
        host,
      );
      const draftGameId = created.data.insert_draft_games_one.id;

      const joiner = await fx.player();
      const result = await gql(
        `mutation {
          insert_draft_game_players_one(object: {
            draft_game_id: "${draftGameId}"
            steam_id: "${joiner}"
          }) { steam_id }
        }`,
        "user",
        joiner,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.insert_draft_game_players_one?.steam_id).toBeDefined();
    });
  });

  describe("lobby invite acceptance", () => {
    // tai_lobbies auto-enrolls the creator as a lobby_players row read from
    // the session, so the lobby must be created under a real session (same
    // as lobbies.spec.ts's createLobby) rather than a bare raw insert.
    const createLobbyWithInvite = (creator: string) =>
      runAsUser(postgres, creator, "user", async (query) => {
        const [row] = (await query(
          "INSERT INTO lobbies (access) VALUES ('Private') RETURNING id",
        )) as Array<{ id: string }>;
        return row.id;
      });

    const invite = (lobbyId: string, steamId: string) =>
      postgres.query(
        "INSERT INTO lobby_players (lobby_id, steam_id, status) VALUES ($1, $2, 'Invited')",
        [lobbyId, steamId],
      );

    it("denies an unaccepted player from accepting a lobby invite", async () => {
      const creator = await fx.player();
      const lobbyId = await createLobbyWithInvite(creator);
      const invitee = await unacceptedPlayer();
      await invite(lobbyId, invitee);

      const result = await gql(
        `mutation {
          update_lobby_players_by_pk(
            pk_columns: { lobby_id: "${lobbyId}", steam_id: "${invitee}" }
            _set: { status: Accepted }
          ) { status }
        }`,
        "user",
        invitee,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.update_lobby_players_by_pk).toBeNull();
    });

    it("allows an accepted player to accept a lobby invite", async () => {
      const creator = await fx.player();
      const lobbyId = await createLobbyWithInvite(creator);
      const invitee = await fx.player();
      await invite(lobbyId, invitee);

      const result = await gql(
        `mutation {
          update_lobby_players_by_pk(
            pk_columns: { lobby_id: "${lobbyId}", steam_id: "${invitee}" }
            _set: { status: Accepted }
          ) { status }
        }`,
        "user",
        invitee,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.update_lobby_players_by_pk?.status).toBe("Accepted");
    });
  });
});
