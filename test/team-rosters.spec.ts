import path from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { HasuraService } from "./../src/hasura/hasura.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the team / roster / lineup-membership triggers: owner bootstrap
// and captain rules on teams, invite conversion on team_roster, captain
// election and ban enforcement on match_lineup_players, and the sanction
// trigger that clears the VAC flag.
describe("teams, rosters and lineup membership (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TeamRostersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const seedPlayer = () => fx.player();

  // tbi_team_roster reads current_setting('hasura.user') without a fallback, so
  // roster writes must carry a user context.
  const asUser = <T>(
    steamId: string,
    role: string,
    fn: (
      query: (sql: string, params?: Array<unknown>) => Promise<unknown>,
    ) => Promise<T>,
  ) => runAsUser(postgres, steamId, role, fn);

  const createTeam = async (owner: string) => {
    const [team] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("team"), owner],
    );
    return team.id;
  };

  const getTeamCaptain = async (teamId: string) => {
    const [team] = await postgres.query<
      Array<{ captain_steam_id: string | null }>
    >("SELECT captain_steam_id FROM teams WHERE id = $1", [teamId]);
    return team.captain_steam_id;
  };

  const rosterRow = async (teamId: string, steam: string) => {
    const [row] = await postgres.query<Array<{ role: string }>>(
      "SELECT role FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
      [teamId, steam],
    );
    return row;
  };

  describe("teams and team_roster", () => {
    it("creating a team enrolls the owner as Admin and captain", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      expect((await rosterRow(teamId, owner))?.role).toBe("Admin");
      expect(await getTeamCaptain(teamId)).toBe(owner);
    });

    it("a regular user adding a player creates an invite instead of a roster row", async () => {
      const owner = await seedPlayer();
      const invitee = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "user", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, invitee],
        ),
      );

      expect(await rosterRow(teamId, invitee)).toBeUndefined();
      const invites = await postgres.query<
        Array<{ invited_by_player_steam_id: string }>
      >(
        "SELECT invited_by_player_steam_id FROM team_invites WHERE team_id = $1 AND steam_id = $2",
        [teamId, invitee],
      );
      expect(invites.length).toBe(1);
      expect(invites[0].invited_by_player_steam_id).toBe(owner);
    });

    it("an admin adds players to the roster directly as Member", async () => {
      const owner = await seedPlayer();
      const member = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, member],
        ),
      );

      expect((await rosterRow(teamId, member))?.role).toBe("Member");
    });

    it("rejects a captain who is not on the roster", async () => {
      const owner = await seedPlayer();
      const outsider = await seedPlayer();
      const teamId = await createTeam(owner);

      await expect(
        postgres.query("UPDATE teams SET captain_steam_id = $1 WHERE id = $2", [
          outsider,
          teamId,
        ]),
      ).rejects.toThrow(/captain must be a team member/i);
    });

    it("removing the captain from the roster falls back to the owner", async () => {
      const owner = await seedPlayer();
      const member = await seedPlayer();
      const teamId = await createTeam(owner);

      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, member],
        ),
      );
      await postgres.query(
        "UPDATE teams SET captain_steam_id = $1 WHERE id = $2",
        [member, teamId],
      );

      await postgres.query(
        "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, member],
      );

      expect(await getTeamCaptain(teamId)).toBe(owner);
    });

    it("removing the owner-captain from the roster leaves the team captainless", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);

      await postgres.query(
        "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, owner],
      );

      expect(await getTeamCaptain(teamId)).toBeNull();
    });
  });

  describe("roster status caps and coach slots (tbiu_team_roster_status)", () => {
    const setStatus = (teamId: string, steam: string, status: string) =>
      postgres.query(
        "UPDATE team_roster SET status = $3 WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, steam, status],
      );

    const setCoach = (teamId: string, steam: string, coach: boolean) =>
      postgres.query(
        "UPDATE team_roster SET coach = $3 WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, steam, coach],
      );

    const rosterStatusAndCoach = async (teamId: string, steam: string) => {
      const [row] = await postgres.query<
        Array<{ status: string; coach: boolean }>
      >(
        "SELECT status, coach FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, steam],
      );
      return row;
    };

    const addMember = async (teamId: string, owner: string) => {
      const player = await seedPlayer();
      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
          [teamId, player],
        ),
      );
      return player;
    };

    it("a coach promoted to Starter atomically clears coach and enforces the 5-starter cap", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      const coach = await addMember(teamId, owner);
      await setCoach(teamId, coach, true);

      // Fill all 5 real starter slots (owner + 4 more).
      await setStatus(teamId, owner, "Starter");
      for (let i = 0; i < 4; i++) {
        const starter = await addMember(teamId, owner);
        await setStatus(teamId, starter, "Starter");
      }

      // A coach's own stale status never counted, so promoting them once the
      // team already has 5 real starters must fail with a clear error, not
      // silently succeed or silently fail.
      await expect(
        postgres.query(
          "UPDATE team_roster SET status = 'Starter', coach = false WHERE team_id = $1 AND player_steam_id = $2",
          [teamId, coach],
        ),
      ).rejects.toThrow(/Only 5 starters are allowed/);

      // Bench a real starter to free a slot, then the same atomic update succeeds.
      await setStatus(teamId, owner, "Benched");
      await postgres.query(
        "UPDATE team_roster SET status = 'Starter', coach = false WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, coach],
      );
      expect(await rosterStatusAndCoach(teamId, coach)).toEqual({
        status: "Starter",
        coach: false,
      });
    });

    it("a coach's leftover status is excluded from the starter count even before promotion", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      // owner was a Starter before becoming a coach; toggling coach alone
      // (the existing, preserved behavior) never clears status.
      await setStatus(teamId, owner, "Starter");
      await setCoach(teamId, owner, true);

      // 5 other real players can still all become Starters -- the coach's
      // leftover 'Starter' status must not occupy a slot.
      for (let i = 0; i < 5; i++) {
        const starter = await addMember(teamId, owner);
        await setStatus(teamId, starter, "Starter");
      }

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text FROM team_roster WHERE team_id = $1 AND status = 'Starter' AND NOT coach",
        [teamId],
      );
      expect(count).toBe("5");
    });

    it("Coach to Substitute and Coach to Benched atomically clear coach", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      const coach = await addMember(teamId, owner);
      await setCoach(teamId, coach, true);

      await postgres.query(
        "UPDATE team_roster SET status = 'Substitute', coach = false WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, coach],
      );
      expect(await rosterStatusAndCoach(teamId, coach)).toEqual({
        status: "Substitute",
        coach: false,
      });

      await postgres.query(
        "UPDATE team_roster SET status = 'Benched', coach = false WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, coach],
      );
      expect(await rosterStatusAndCoach(teamId, coach)).toEqual({
        status: "Benched",
        coach: false,
      });
    });

    it("rejects promoting a real Starter beyond the 5-starter cap with a clear error", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      await setStatus(teamId, owner, "Starter");
      for (let i = 0; i < 4; i++) {
        const starter = await addMember(teamId, owner);
        await setStatus(teamId, starter, "Starter");
      }
      const sixth = await addMember(teamId, owner);

      await expect(setStatus(teamId, sixth, "Starter")).rejects.toThrow(
        /Only 5 starters are allowed/,
      );
    });

    it("rejects promoting beyond the substitute cap with a clear error", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      const sub1 = await addMember(teamId, owner);
      const sub2 = await addMember(teamId, owner);
      await setStatus(teamId, sub1, "Substitute");
      await setStatus(teamId, sub2, "Substitute");
      const third = await addMember(teamId, owner);

      await expect(setStatus(teamId, third, "Substitute")).rejects.toThrow(
        /Only 2 substitutes are allowed/,
      );
    });

    it("a new invite cascades Starter -> Substitute -> Benched once each tier is full, never failing on insert", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      await setStatus(teamId, owner, "Starter");
      for (let i = 0; i < 4; i++) {
        const starter = await addMember(teamId, owner);
        await setStatus(teamId, starter, "Starter");
      }
      for (let i = 0; i < 2; i++) {
        const sub = await addMember(teamId, owner);
        await setStatus(teamId, sub, "Substitute");
      }

      const player = await seedPlayer();
      await asUser(owner, "admin", (query) =>
        query(
          "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
          [teamId, player],
        ),
      );

      expect((await rosterStatusAndCoach(teamId, player))?.status).toBe(
        "Benched",
      );
    });

    it("normal player to Coach preserves existing behavior: coach flips without touching status", async () => {
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      const member = await addMember(teamId, owner);
      await setStatus(teamId, member, "Substitute");

      await setCoach(teamId, member, true);

      expect(await rosterStatusAndCoach(teamId, member)).toEqual({
        status: "Substitute",
        coach: true,
      });
    });

  // Proves the actual production upgrade path for this fix: hasura.setup()
  // applies hasura/triggers/*.sql by comparing a SHA-256 digest of the file
  // against migration_hashes.hashes, and only re-executes it (CREATE OR
  // REPLACE FUNCTION, unconditionally) when the digest differs -- there is
  // no separate "trigger version" tracking. This does NOT rely on the fix
  // already being present from bootMigratedDb's initial setup(); it
  // reinstalls the exact pre-fix function body, records it as already
  // applied (simulating today's production), then calls hasura.apply() on
  // the real on-disk (fixed) file and confirms it is detected as changed
  // and correctly reapplied.
  describe("production upgrade path for the tbiu_team_roster_status fix", () => {
    const OLD_BUGGY_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION public.tbiu_team_roster_status() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _count int;
    _max int;
BEGIN
    IF current_setting('fivestack.rebalancing', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'Starter' THEN
        _max := 5;
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Starter'
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Substitute';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' starters are allowed; bench a starter first';
            END IF;
        END IF;
    END IF;

    IF NEW.status = 'Substitute' THEN
        _max := public.team_max_subs();
        SELECT COUNT(*) INTO _count FROM public.team_roster
        WHERE team_id = NEW.team_id AND status = 'Substitute'
          AND player_steam_id <> NEW.player_steam_id;
        IF _count >= _max THEN
            IF TG_OP = 'INSERT' THEN
                NEW.status := 'Benched';
            ELSE
                RAISE EXCEPTION USING ERRCODE = '22000',
                    MESSAGE = 'Only ' || _max || ' substitutes are allowed';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;`;

    it("hasura.setup()'s digest-gated reapplication actually replaces an already-installed buggy function", async () => {
      const triggersFilePath = path.resolve("./hasura/triggers/team_roster.sql");
      const settingKey = path.relative(
        process.cwd(),
        triggersFilePath.replace(".sql", ""),
      );

      // 1. Reinstall the exact pre-fix function body and record its digest
      //    as already applied -- this is what today's production actually
      //    has, byte for byte, since it was last deployed before this fix.
      await postgres.query(OLD_BUGGY_FUNCTION_SQL);
      const oldDigest = db.hasura.calcSqlDigest(OLD_BUGGY_FUNCTION_SQL);
      await db.hasura.setSetting(settingKey, oldDigest);
      expect(await db.hasura.getSetting(settingKey)).toBe(oldDigest);

      // 2. Confirm the bug is really back: a coach's leftover Starter status
      //    occupies a real slot again. team_roster.status defaults to
      //    'Starter', so the team owner is already one of the 5 -- coach
      //    plus 3 more (not 4) exactly fills the cap under the reinstated bug.
      const owner = await seedPlayer();
      const teamId = await createTeam(owner);
      const coach = await addMember(teamId, owner);
      await setStatus(teamId, coach, "Starter");
      await setCoach(teamId, coach, true);
      for (let i = 0; i < 3; i++) {
        const starter = await addMember(teamId, owner);
        await setStatus(teamId, starter, "Starter");
      }
      const sixth = await addMember(teamId, owner);
      await expect(setStatus(teamId, sixth, "Starter")).rejects.toThrow(
        /Only 5 starters are allowed/,
      );

      // 3. This is the actual deployment step: hasura.setup() -> apply() on
      //    the real, on-disk (fixed) file. It must detect the digest
      //    mismatch against what was just recorded as "applied" and
      //    reapply, with no new migration and no manual intervention.
      await db.hasura.apply(triggersFilePath);
      expect(await db.hasura.getSetting(settingKey)).not.toBe(oldDigest);

      // 4. The bug is now fixed against the SAME rows from step 2, proving
      //    this was a live reapplication, not a fresh install.
      await setStatus(teamId, sixth, "Starter");
      expect((await rosterStatusAndCoach(teamId, sixth))?.status).toBe(
        "Starter",
      );
    });
  });
  });

  describe("match lineup membership", () => {
    // Wingman keeps lineups at two slots, enough for captain-handover tests.
    const createMatch = () => fx.match({ type: "Wingman", mr: 8, mapVeto: true });

    const addPlayer = (lineupId: string, steam?: string) =>
      fx.lineupPlayer(lineupId, steam);

    const lineupPlayers = (lineupId: string) =>
      postgres.query<Array<{ steam_id: string; captain: boolean }>>(
        "SELECT steam_id, captain FROM match_lineup_players WHERE match_lineup_id = $1 ORDER BY steam_id",
        [lineupId],
      );

    it("the first player to join a lineup becomes captain", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.find((p) => p.steam_id === first)?.captain).toBe(true);
      expect(players.find((p) => p.steam_id === second)?.captain).toBe(false);
    });

    it("rejects joining both lineups of the same match", async () => {
      const match = await createMatch();
      const player = await addPlayer(match.lineup_1_id);

      await expect(addPlayer(match.lineup_2_id, player)).rejects.toThrow(
        /already added to match/i,
      );
    });

    it("rejects a lineup beyond the type's capacity", async () => {
      const match = await createMatch();
      await addPlayer(match.lineup_1_id);
      await addPlayer(match.lineup_1_id);

      await expect(addPlayer(match.lineup_1_id)).rejects.toThrow(
        /Max number of players/i,
      );
    });

    it("promoting a player to captain demotes the previous captain", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      await postgres.query(
        "UPDATE match_lineup_players SET captain = true WHERE match_lineup_id = $1 AND steam_id = $2",
        [match.lineup_1_id, second],
      );

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.find((p) => p.steam_id === first)?.captain).toBe(false);
      expect(players.find((p) => p.steam_id === second)?.captain).toBe(true);
    });

    it("deleting the captain elects a replacement", async () => {
      const match = await createMatch();
      const first = await addPlayer(match.lineup_1_id);
      const second = await addPlayer(match.lineup_1_id);

      await postgres.query(
        "DELETE FROM match_lineup_players WHERE match_lineup_id = $1 AND steam_id = $2",
        [match.lineup_1_id, first],
      );

      const players = await lineupPlayers(match.lineup_1_id);
      expect(players.length).toBe(1);
      expect(players[0].steam_id).toBe(second);
      expect(players[0].captain).toBe(true);
    });

    it("a captain moved to the other lineup loses captaincy and both lineups re-elect", async () => {
      const match = await createMatch();
      const cap = await addPlayer(match.lineup_1_id);
      const mate = await addPlayer(match.lineup_1_id);
      const opponent = await addPlayer(match.lineup_2_id);

      await postgres.query(
        "UPDATE match_lineup_players SET match_lineup_id = $1 WHERE steam_id = $2",
        [match.lineup_2_id, cap],
      );

      const lineup1 = await lineupPlayers(match.lineup_1_id);
      expect(lineup1.length).toBe(1);
      expect(lineup1[0].steam_id).toBe(mate);
      expect(lineup1[0].captain).toBe(true);

      const lineup2 = await lineupPlayers(match.lineup_2_id);
      expect(lineup2.find((p) => p.steam_id === cap)?.captain).toBe(false);
      expect(lineup2.find((p) => p.steam_id === opponent)?.captain).toBe(true);
    });

    it("rejects players with an active ban and admits them once it is lifted or expired", async () => {
      const match = await createMatch();
      const admin = await seedPlayer();
      const banned = await seedPlayer();

      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', $2) RETURNING id`,
        [banned, admin],
      );
      await expect(addPlayer(match.lineup_1_id, banned)).rejects.toThrow(
        /Currently Banned/i,
      );

      // Soft-deleting the sanction lifts the ban.
      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );
      await addPlayer(match.lineup_1_id, banned);

      // An expired ban does not block either.
      const expired = await seedPlayer();
      await postgres.query(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id, remove_sanction_date)
         VALUES ($1, 'ban', $2, now() - interval '1 day')`,
        [expired, admin],
      );
      await addPlayer(match.lineup_2_id, expired);
    });
  });

  describe("player sanctions (tau_player_sanctions)", () => {
    it("soft-deleting an automatic ban clears the VAC flag", async () => {
      const player = await seedPlayer();
      await postgres.query(
        "UPDATE players SET vac_banned = true WHERE steam_id = $1",
        [player],
      );
      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', NULL) RETURNING id`,
        [player],
      );

      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );

      const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
        "SELECT vac_banned FROM players WHERE steam_id = $1",
        [player],
      );
      expect(row.vac_banned).toBe(false);
    });

    it("soft-deleting a manual ban leaves the VAC flag alone", async () => {
      const admin = await seedPlayer();
      const player = await seedPlayer();
      await postgres.query(
        "UPDATE players SET vac_banned = true WHERE steam_id = $1",
        [player],
      );
      const [sanction] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO player_sanctions (player_steam_id, type, sanctioned_by_steam_id)
         VALUES ($1, 'ban', $2) RETURNING id`,
        [player, admin],
      );

      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE id = $1",
        [sanction.id],
      );

      const [row] = await postgres.query<Array<{ vac_banned: boolean }>>(
        "SELECT vac_banned FROM players WHERE steam_id = $1",
        [player],
      );
      expect(row.vac_banned).toBe(true);
    });
  });
});
