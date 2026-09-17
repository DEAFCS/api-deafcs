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
