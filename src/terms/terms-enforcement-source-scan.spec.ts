import fs from "fs";
import path from "path";

// A maintained inventory of every "Group A" write path that must call
// TermsService.assertAccepted (Hasura Action handlers) or reference
// has_accepted_current_terms (declarative Hasura permission files / the
// draft_game_picks trigger). This is a regression tripwire, not business
// -logic coverage: if a future refactor moves a handler, renames a method,
// or drops the helper call, this fails loudly instead of silently
// reopening a Terms-acceptance bypass. Keep in sync with CLAUDE.md /
// the Terms-acceptance implementation report if the gated set changes.

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Terms-acceptance enforcement source scan", () => {
  describe("Group A Hasura Action handlers call TermsService.assertAccepted", () => {
    const handlers: Array<{ file: string; methods: Array<string> }> = [
      {
        file: "src/matches/matches.controller.ts",
        methods: [
          "createScheduledMatch",
          "scheduleMatch",
          "startMatch",
          "cancelMatch",
          "forfeitMatch",
          "checkIntoMatch",
          "leaveLineup",
          "switchLineup",
          "randomizeTeams",
          "swapLineups",
        ],
      },
      {
        file: "src/tournaments/tournaments.controller.ts",
        methods: [
          "deleteTournament",
          "generateTournamentTeams",
          "checkIntoTournament",
          "checkInTournamentTeam",
          "checkInTournamentIndividualPlayer",
        ],
      },
      {
        file: "src/invites/invites.controller.ts",
        methods: ["acceptInvite"],
      },
      {
        file: "src/draft-games/draft-games.controller.ts",
        methods: [
          "createDraftGame",
          "joinDraftGame",
          "joinDraftGameAsParty",
          "addDraftPlayer",
          "respondDraftInvite",
        ],
      },
      {
        file: "src/scrims/scrims.controller.ts",
        methods: [
          "sendScrimRequest",
          "respondToScrimRequest",
          "counterScrimRequest",
        ],
      },
    ];

    for (const { file, methods } of handlers) {
      describe(file, () => {
        const source = read(file);

        for (const method of methods) {
          it(`${method} calls this.terms.assertAccepted`, () => {
            // Extract from this method's signature up to the next
            // `@HasuraAction()`/`@HasuraEvent()`-preceded method (or EOF),
            // so the assertion only looks inside this one handler's body.
            const start = source.indexOf(`async ${method}(`);
            expect(start).toBeGreaterThan(-1);
            const rest = source.slice(start);
            const nextHandler = rest.slice(1).search(/@HasuraAction\(\)|@HasuraEvent\(\)/);
            const body =
              nextHandler === -1 ? rest : rest.slice(0, nextHandler + 1);
            expect(body).toMatch(/this\.terms\.assertAccepted\(/);
          });
        }
      });
    }
  });

  it("acceptTerms itself does not call assertAccepted (it is the escape hatch)", () => {
    const source = read("src/auth/auth.controller.ts");
    const start = source.indexOf("async acceptTerms(");
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextHandler = rest.slice(1).search(/@HasuraAction\(\)/);
    const body = nextHandler === -1 ? rest : rest.slice(0, nextHandler + 1);
    expect(body).not.toMatch(/this\.terms\.assertAccepted\(/);
    expect(body).toMatch(/this\.terms\.acceptCurrentTerms\(/);
  });

  describe("matchmaking gateway enforces Terms for join-queue (party-wide) and confirm", () => {
    const source = read("src/matchmaking/matchmaking.gateway.ts");

    it("joinQueue checks every party member via hasAcceptedCurrentTerms, not just the caller", () => {
      const start = source.indexOf("async joinQueue(");
      const body = source.slice(start, source.indexOf("async leaveQueue("));
      expect(body).toMatch(/for \(const player of lobby\.players\)/);
      expect(body).toMatch(/this\.terms\.hasAcceptedCurrentTerms\(player\.steam_id\)/);
    });

    it("playerConfirmation checks the confirming user", () => {
      const start = source.indexOf("async playerConfirmation(");
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start);
      expect(body).toMatch(/this\.terms\.hasAcceptedCurrentTerms\(user\.steam_id\)/);
    });
  });

  // public_team_roster.yaml is deliberately NOT in this list: its insert
  // permission was investigated and reverted to the original, unmodified
  // check (see terms-acceptance-permissions.spec.ts's comment) -- the
  // tbi_team_roster trigger silently redirects every non-owner/non-admin
  // insert into a team_invites row and returns NULL before Hasura's
  // permission check clause ever matters, so a Terms condition there would
  // be dead code. Real team-membership joins go through acceptInvite,
  // already gated by TermsService.assertAccepted.
  describe("Hasura permission files reference has_accepted_current_terms", () => {
    const files = [
      "hasura/metadata/databases/default/tables/public_tournament_teams.yaml",
      "hasura/metadata/databases/default/tables/public_tournament_individual_signups.yaml",
      "hasura/metadata/databases/default/tables/public_teams.yaml",
      "hasura/metadata/databases/default/tables/public_tournament_team_roster.yaml",
      "hasura/metadata/databases/default/tables/public_draft_games.yaml",
      "hasura/metadata/databases/default/tables/public_draft_game_players.yaml",
      "hasura/metadata/databases/default/tables/public_lobby_players.yaml",
    ];

    for (const file of files) {
      it(`${file} references has_accepted_current_terms`, () => {
        expect(read(file)).toMatch(/has_accepted_current_terms/);
      });
    }
  });

  it("the draft_game_picks trigger checks player_has_accepted_current_terms", () => {
    expect(read("hasura/triggers/draft_game_picks.sql")).toMatch(
      /player_has_accepted_current_terms/,
    );
  });

  it("acceptTerms is registered as a Hasura Action for role user", () => {
    const actions = read("hasura/metadata/actions.yaml");
    const start = actions.indexOf("- name: acceptTerms");
    expect(start).toBeGreaterThan(-1);
    const nextAction = actions.indexOf("\n  - name:", start + 1);
    const block = actions.slice(start, nextAction === -1 ? undefined : nextAction);
    expect(block).toMatch(/role: user/);
  });
});
