import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// SQL-level coverage for the Terms-acceptance primitives: the
// player_terms_acceptances table, the has_accepted_current_terms /
// player_has_accepted_current_terms functions, the public.terms_version
// setting's fail-closed behavior, and the draft_game_picks trigger's
// enforcement (a real Postgres trigger, so directly testable here --
// unlike the declarative Hasura table permissions, which need a live
// Hasura engine and are covered separately in
// terms-acceptance-permissions.spec.ts).
describe("Terms acceptance (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TermsAcceptanceTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199964000000n);
    // The draft_games insert trigger refuses to create a game when no
    // server region is available.
    await postgres.query(
      "INSERT INTO server_regions (value, is_lan) VALUES ('TestA', false) ON CONFLICT (value) DO NOTHING",
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
       VALUES ('127.0.0.1', 'TestA-server', '\\x00'::bytea, 27915, true, 'TestA', 'Ranked', true)
       ON CONFLICT DO NOTHING`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM draft_games");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const hasAccepted = async (steamId: string): Promise<boolean> => {
    const [row] = await postgres.query<Array<{ accepted: boolean }>>(
      "SELECT has_accepted_current_terms(p) AS accepted FROM players p WHERE steam_id = $1",
      [steamId],
    );
    return row.accepted;
  };

  const acceptancesFor = (steamId: string) =>
    postgres.query<Array<{ terms_version: string }>>(
      "SELECT terms_version FROM player_terms_acceptances WHERE player_steam_id = $1 ORDER BY terms_version",
      [steamId],
    );

  const setTermsVersion = (version: string | null) =>
    version === null
      ? postgres.query("DELETE FROM settings WHERE name = 'public.terms_version'")
      : postgres.query(
          `INSERT INTO settings (name, value) VALUES ('public.terms_version', $1)
           ON CONFLICT (name) DO UPDATE SET value = $1`,
          [version],
        );

  const currentVersion = async (): Promise<string> => {
    const [row] = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM settings WHERE name = 'public.terms_version'",
    );
    return row.value;
  };

  describe("acceptance lifecycle", () => {
    it("a fresh player has not accepted the current terms", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      expect(await hasAccepted(steam)).toBe(false);
    });

    it("accepting the current version flips the computed field to true", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      await fx.acceptCurrentTerms(steam);
      expect(await hasAccepted(steam)).toBe(true);
    });

    it("accepting the same version twice is idempotent (one row, no error)", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      await fx.acceptCurrentTerms(steam);
      await expect(fx.acceptCurrentTerms(steam)).resolves.not.toThrow();
      expect(await hasAccepted(steam)).toBe(true);
      const rows = await acceptancesFor(steam);
      expect(rows.length).toBe(1);
    });

    it("bumping the terms version makes a previously-accepted player unaccepted again", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      const original = await currentVersion();
      await fx.acceptCurrentTerms(steam);
      expect(await hasAccepted(steam)).toBe(true);

      await setTermsVersion("9999-01-01");
      expect(await hasAccepted(steam)).toBe(false);

      // restore, since the setting is process-wide within this DB
      await setTermsVersion(original);
    });

    it("accepting the new version after a bump restores true and preserves BOTH historical rows", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      const original = await currentVersion();
      await fx.acceptCurrentTerms(steam);

      await setTermsVersion("9999-01-02");
      expect(await hasAccepted(steam)).toBe(false);

      await fx.acceptCurrentTerms(steam);
      expect(await hasAccepted(steam)).toBe(true);

      const rows = await acceptancesFor(steam);
      expect(rows.map((r) => r.terms_version).sort()).toEqual(
        [original, "9999-01-02"].sort(),
      );

      await setTermsVersion(original);
    });
  });

  describe("missing-version behavior", () => {
    it("has_accepted_current_terms is false for everyone when no version is configured, even with an acceptance row on file", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      const original = await currentVersion();
      await fx.acceptCurrentTerms(steam);
      expect(await hasAccepted(steam)).toBe(true);

      await setTermsVersion(null);
      expect(await hasAccepted(steam)).toBe(false);

      await setTermsVersion(original);
      expect(await hasAccepted(steam)).toBe(true);
    });

    it("a blank (empty-string) version is treated the same as missing, not as a matchable value", async () => {
      const steam = await fx.player(undefined, { acceptTerms: false });
      const original = await currentVersion();

      await setTermsVersion("");
      // An acceptance row can't even be recorded for a blank version since
      // fx.acceptCurrentTerms mirrors the real fail-closed service and
      // refuses when no valid version is configured.
      await expect(fx.acceptCurrentTerms(steam)).rejects.toThrow();
      expect(await hasAccepted(steam)).toBe(false);

      await setTermsVersion(original);
    });
  });

  describe("draft_game_picks trigger enforcement", () => {
    // Mirrors draft-order.spec.ts's createDraft/pickAs helpers, trimmed to
    // the two-captain minimum needed to exercise one pick.
    const createTwoCaptainDraft = async () => {
      const host = await fx.player();
      const [{ id }] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO draft_games (host_steam_id, type, draft_order, status)
         VALUES ($1, 'Wingman', 'Alternating', 'Open') RETURNING id`,
        [host],
      );
      const cap1 = await fx.player();
      const cap2 = await fx.player();
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, is_captain, lineup, status)
         VALUES ($1, $2, true, 1, 'Accepted')`,
        [id, cap1],
      );
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, is_captain, lineup, status)
         VALUES ($1, $2, true, 2, 'Accepted')`,
        [id, cap2],
      );
      const pick = await fx.player();
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status)
         VALUES ($1, $2, 'Accepted')`,
        [id, pick],
      );
      await postgres.query(
        "UPDATE draft_games SET status = 'Drafting', current_pick_lineup = 1 WHERE id = $1",
        [id],
      );
      return { id, cap1, cap2, pick };
    };

    // set_config is transaction-local, so the pick must share the connection.
    const pickAs = (draftGameId: string, captainSteam: string, pickedSteam: string) =>
      postgres.transaction(async (client) => {
        await client.query("SELECT set_config('hasura.user', $1, true)", [
          JSON.stringify({ "x-hasura-user-id": captainSteam }),
        ]);
        await client.query(
          "INSERT INTO draft_game_picks (draft_game_id, picked_steam_id) VALUES ($1, $2)",
          [draftGameId, pickedSteam],
        );
      });

    it("rejects a pick from a captain who has not accepted the current terms", async () => {
      const { id, cap1, pick } = await createTwoCaptainDraft();
      // cap1 is created via fx.player() (accepted by default); explicitly
      // withdraw their acceptance for this test.
      await postgres.query(
        "DELETE FROM player_terms_acceptances WHERE player_steam_id = $1",
        [cap1],
      );
      await expect(pickAs(id, cap1, pick)).rejects.toThrow(
        /accept the current terms/i,
      );
    });

    it("allows a pick from a captain who has accepted the current terms", async () => {
      const { id, cap1, pick } = await createTwoCaptainDraft();
      await expect(pickAs(id, cap1, pick)).resolves.not.toThrow();
      const [row] = await postgres.query<Array<{ lineup: number | null }>>(
        "SELECT lineup FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
        [id, pick],
      );
      expect(row.lineup).toBe(1);
    });

    it("does not require terms acceptance for the actor-less server-side auto-pick path", async () => {
      // No hasura.user session set at all -- mirrors the automatic pick the
      // pick-timeout job performs (draft.service.ts autoPick, which supplies
      // captain_steam_id itself since the trigger's actor-less early return
      // leaves it unset), which must keep working regardless of any
      // player's Terms status.
      const { id, cap1, pick } = await createTwoCaptainDraft();
      await expect(
        postgres.query(
          `INSERT INTO draft_game_picks (draft_game_id, picked_steam_id, captain_steam_id, lineup)
           VALUES ($1, $2, $3, 1)`,
          [id, pick, cap1],
        ),
      ).resolves.not.toThrow();
    });
  });
});
