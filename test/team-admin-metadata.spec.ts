import fs from "fs";
import path from "path";
import { load } from "js-yaml";

const metadata = (relativePath: string) =>
  load(
    fs.readFileSync(
      path.resolve("hasura/metadata/databases/default", relativePath),
      "utf8",
    ),
  ) as Record<string, any>;

describe("team Admin Hasura metadata", () => {
  it("scopes user roster writes to the exact owner/Admin caller", () => {
    const roster = metadata("tables/public_team_roster.yaml");
    const userInsert = roster.insert_permissions.find(
      (entry: any) => entry.role === "user",
    );
    const userUpdate = roster.update_permissions.find(
      (entry: any) => entry.role === "user",
    );
    const userDelete = roster.delete_permissions.find(
      (entry: any) => entry.role === "user",
    );

    for (const predicate of [
      userInsert.permission.check,
      userUpdate.permission.filter,
      userDelete.permission.filter,
    ]) {
      const serialized = JSON.stringify(predicate);
      expect(serialized).toContain("X-Hasura-User-Id");
      expect(serialized).toContain("player_steam_id");
    }

    expect(JSON.stringify(userUpdate.permission.check)).toContain(
      '"role":{"_eq":"Admin"}',
    );
  });

  it("gives site administrators exactly the moderation can_remove / can_change_role promise", () => {
    const roster = metadata("tables/public_team_roster.yaml");
    const teams = metadata("tables/public_teams.yaml");
    const pick = (list: any[], role: string) =>
      list.find((entry: any) => entry.role === role);

    // roster: delete and update, never insert; no extra columns (roster_image_url
    // stays out of every role's reach).
    expect(pick(roster.delete_permissions, "administrator").permission.filter).toEqual({});
    const rosterUpdate = pick(roster.update_permissions, "administrator").permission;
    expect(rosterUpdate.filter).toEqual({});
    expect(rosterUpdate.columns.sort()).toEqual(["coach", "role", "status"]);
    expect(pick(roster.insert_permissions, "administrator")).toBeUndefined();

    // teams: a site administrator may delete, not rewrite a team.
    expect(pick(teams.delete_permissions, "administrator").permission.filter).toEqual({});
    expect(pick(teams.update_permissions, "administrator")).toBeUndefined();

    // Nobody else gained anything: the user rules are unchanged (owner / Admin).
    expect(JSON.stringify(pick(teams.delete_permissions, "user").permission.filter)).toBe(
      '{"owner_steam_id":{"_eq":"x-hasura-user-id"}}',
    );
    for (const entry of [...roster.delete_permissions, ...roster.update_permissions]) {
      if (entry.role !== "user" && entry.role !== "administrator") {
        throw new Error("unexpected team_roster writer: " + entry.role);
      }
    }
  });

  it("exposes teams.created_at read-only", () => {
    const teams = metadata("tables/public_teams.yaml");
    const select = teams.select_permissions.find((entry: any) => entry.role === "guest");
    expect(select.permission.columns).toContain("created_at");
    for (const list of [teams.insert_permissions, teams.update_permissions]) {
      for (const entry of list) {
        expect(entry.permission.columns).not.toContain("created_at");
      }
    }
  });

  it("exposes orphan recovery only to site administrators", () => {
    const recovery = metadata("functions/public_recover_team_admin.yaml");
    expect(recovery.configuration).toMatchObject({
      exposed_as: "mutation",
      session_argument: "hasura_session",
    });
    expect(recovery.permissions).toEqual([{ role: "administrator" }]);
  });

  it("keeps the audit trail read-only and site-admin-only", () => {
    const audit = metadata("tables/public_team_admin_audit.yaml");
    expect(audit.select_permissions).toHaveLength(1);
    expect(audit.select_permissions[0].role).toBe("administrator");
    expect(audit.insert_permissions).toBeUndefined();
    expect(audit.update_permissions).toBeUndefined();
    expect(audit.delete_permissions).toBeUndefined();
  });
});
