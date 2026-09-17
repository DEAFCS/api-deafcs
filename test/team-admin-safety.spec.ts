import { PostgresService } from "../src/postgres/postgres.service";
import fs from "fs";
import path from "path";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

const LAST_ADMIN_MESSAGE =
  "You are the last team Admin. Assign another Admin before changing your role or leaving the team.";

describe("team Admin safety (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TeamAdminSafetyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199961000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM team_admin_audit");
    await postgres.query("DELETE FROM player_terms_acceptances");
    await postgres.query("DELETE FROM players");
  });

  const session = (steamId: string, role = "user") =>
    JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

  const roster = (teamId: string) =>
    postgres.query<Array<{ player_steam_id: string; role: string }>>(
      `SELECT player_steam_id, role
       FROM team_roster
       WHERE team_id = $1
       ORDER BY player_steam_id`,
      [teamId],
    );

  const setRole = (
    actorSteamId: string,
    teamId: string,
    playerSteamId: string,
    role: "Admin" | "Invite" | "Member",
    actorRole = "user",
  ) =>
    runAsUser(postgres, actorSteamId, actorRole, (query) =>
      query(
        `UPDATE team_roster
         SET role = $3
         WHERE team_id = $1 AND player_steam_id = $2`,
        [teamId, playerSteamId, role],
      ),
    );

  it("creates every team with its owner as the first audited Admin", async () => {
    const team = await fx.team();

    expect(await roster(team.id)).toEqual([
      { player_steam_id: team.owner, role: "Admin" },
    ]);
    await expect(
      postgres.query(
        `SELECT 1 FROM team_admin_audit
         WHERE team_id = $1
           AND player_steam_id = $2
           AND previous_role IS NULL
           AND new_role = 'Admin'
           AND action = 'admin_granted'`,
        [team.id, team.owner],
      ),
    ).resolves.toHaveLength(1);
  });

  it("blocks the final Admin from demoting themselves", async () => {
    const team = await fx.team();

    await expect(
      setRole(team.owner, team.id, team.owner, "Member"),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
    expect((await roster(team.id))[0].role).toBe("Admin");
  });

  it("blocks the final Admin from leaving", async () => {
    const team = await fx.team();

    await expect(
      runAsUser(postgres, team.owner, "user", (query) =>
        query(
          "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, team.owner],
        ),
      ),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
  });

  it("blocks an owner from removing another member who is the final Admin", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;
    await setRole(team.owner, team.id, mate.player_steam_id, "Admin");
    await setRole(team.owner, team.id, team.owner, "Member");

    await expect(
      runAsUser(postgres, team.owner, "user", (query) =>
        query(
          "DELETE FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, mate.player_steam_id],
        ),
      ),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
  });

  it("allows one of two Admins to be demoted and preserves management access", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;

    await setRole(team.owner, team.id, mate.player_steam_id, "Admin");
    await setRole(team.owner, team.id, team.owner, "Member");

    const [access] = await postgres.query<Array<{ allowed: boolean }>>(
      `SELECT can_change_team_role(t, $2::json) AS allowed
       FROM teams t WHERE id = $1`,
      [team.id, session(mate.player_steam_id)],
    );
    expect(access.allowed).toBe(true);
    expect(
      (await roster(team.id)).filter((member) => member.role === "Admin"),
    ).toHaveLength(1);
  });

  it("allows an authorized owner/Admin to promote a member and audits the actor", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;

    await setRole(team.owner, team.id, mate.player_steam_id, "Admin");

    const [audit] = await postgres.query<
      Array<{ action: string; actor_steam_id: string; actor_role: string }>
    >(
      `SELECT action, actor_steam_id, actor_role
       FROM team_admin_audit
       WHERE team_id = $1 AND player_steam_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [team.id, mate.player_steam_id],
    );
    expect(audit).toEqual({
      action: "admin_granted",
      actor_steam_id: team.owner,
      actor_role: "user",
    });
  });

  it("rejects an unauthorized member promoting themselves", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;

    await expect(
      setRole(mate.player_steam_id, team.id, mate.player_steam_id, "Admin"),
    ).rejects.toThrow("not authorized to manage this team roster");
    expect(
      (await roster(team.id)).find(
        (member) => member.player_steam_id === mate.player_steam_id,
      )?.role,
    ).toBe("Member");
  });

  it("serializes concurrent demotions so one Admin always remains", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;
    await setRole(team.owner, team.id, mate.player_steam_id, "Admin");

    const pool = (
      postgres as unknown as {
        pool: {
          connect(): Promise<{
            query(sql: string, params?: unknown[]): Promise<unknown>;
            release(): void;
          }>;
        };
      }
    ).pool;
    const first = await pool.connect();
    const second = await pool.connect();

    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query("SELECT set_config('hasura.user', $1, true)", [
        session(team.owner),
      ]);
      await second.query("SELECT set_config('hasura.user', $1, true)", [
        session(mate.player_steam_id),
      ]);

      await first.query(
        "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, team.owner],
      );
      const competing = second.query(
        "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
        [team.id, mate.player_steam_id],
      );
      await first.query("COMMIT");
      await expect(competing).rejects.toThrow(LAST_ADMIN_MESSAGE);
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }

    expect(
      (await roster(team.id)).filter((member) => member.role === "Admin"),
    ).toHaveLength(1);
  });

  it("keeps captain and Admin responsibilities independent", async () => {
    const team = await fx.team(1);
    const mate = (await roster(team.id)).find(
      (member) => member.player_steam_id !== team.owner,
    )!;
    await postgres.query(
      "UPDATE teams SET captain_steam_id = $2 WHERE id = $1",
      [team.id, mate.player_steam_id],
    );
    await setRole(team.owner, team.id, mate.player_steam_id, "Admin");
    await setRole(team.owner, team.id, mate.player_steam_id, "Member");

    const [row] = await postgres.query<Array<{ captain_steam_id: string }>>(
      "SELECT captain_steam_id FROM teams WHERE id = $1",
      [team.id],
    );
    expect(row.captain_steam_id).toBe(mate.player_steam_id);
  });

  it("allows deliberate team deletion and its roster cascade", async () => {
    const team = await fx.team(1);
    await expect(
      postgres.query("DELETE FROM teams WHERE id = $1", [team.id]),
    ).resolves.not.toThrow();
    expect(await roster(team.id)).toHaveLength(0);
  });

  it("restricts orphan recovery to site administrators and records the reason", async () => {
    const team = await fx.team();
    const staff = await fx.player("RecoveryStaff");

    await postgres.query(
      "ALTER TABLE team_roster DISABLE TRIGGER tbud_team_roster_admin_guard",
    );
    await postgres.query(
      "ALTER TABLE team_roster DISABLE TRIGGER ct_team_roster_admin_guard",
    );
    try {
      await postgres.query(
        "UPDATE team_roster SET role = 'Member' WHERE team_id = $1",
        [team.id],
      );
    } finally {
      await postgres.query(
        "ALTER TABLE team_roster ENABLE TRIGGER tbud_team_roster_admin_guard",
      );
      await postgres.query(
        "ALTER TABLE team_roster ENABLE TRIGGER ct_team_roster_admin_guard",
      );
    }

    await expect(
      runAsUser(postgres, team.owner, "user", (query) =>
        query("SELECT * FROM recover_team_admin($1, $2, $3, $4::json)", [
          team.id,
          team.owner,
          "Unauthorized attempt",
          session(team.owner),
        ]),
      ),
    ).rejects.toThrow("Site administrator access is required");

    await runAsUser(postgres, staff, "administrator", (query) =>
      query("SELECT * FROM recover_team_admin($1, $2, $3, $4::json)", [
        team.id,
        team.owner,
        "Reviewed orphaned-team recovery",
        session(staff, "administrator"),
      ]),
    );

    expect((await roster(team.id))[0].role).toBe("Admin");
    const [audit] = await postgres.query<
      Array<{ action: string; reason: string; actor_steam_id: string }>
    >(
      `SELECT action, reason, actor_steam_id
       FROM team_admin_audit
       WHERE team_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [team.id],
    );
    expect(audit).toEqual({
      action: "staff_recovery",
      reason: "Reviewed orphaned-team recovery",
      actor_steam_id: staff,
    });
  });

  it("rolls the migration back cleanly in the disposable database", async () => {
    const down = fs.readFileSync(
      path.resolve(
        "hasura/migrations/default/1878000010000_team_admin_safety/down.sql",
      ),
      "utf8",
    );
    await postgres.query(down);

    const [state] = await postgres.query<
      Array<{ audit_table: string | null; recovery_function: string | null }>
    >(
      `SELECT
         to_regclass('public.team_admin_audit')::text AS audit_table,
         to_regprocedure('public.recover_team_admin(uuid,bigint,text,json)')::text
           AS recovery_function`,
    );
    expect(state).toEqual({ audit_table: null, recovery_function: null });
  });
});
