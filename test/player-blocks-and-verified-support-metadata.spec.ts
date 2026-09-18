import fs from "fs";
import path from "node:path";

describe("player blocks + verified support requests: Hasura metadata", () => {
  it("v_my_blocks exposes only the blocker's own outgoing blocks, never the reverse", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_v_my_blocks.yaml",
      ),
      "utf8",
    );
    expect(metadata).toMatch(/select_permissions:[\s\S]*blocker_steam_id:\s*\n\s*_eq: X-Hasura-User-Id/);
    expect(metadata).toMatch(/delete_permissions:[\s\S]*blocker_steam_id:\s*\n\s*_eq: X-Hasura-User-Id/);
    // Never filtered by blocked_steam_id (which would leak "who blocked me").
    expect(metadata).not.toMatch(/filter:\s*\n\s*blocked_steam_id:/);
  });

  it("player_blocks base table has no direct role permissions (all access goes through v_my_blocks)", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_player_blocks.yaml",
      ),
      "utf8",
    );
    expect(metadata).not.toMatch(/select_permissions|insert_permissions|update_permissions|delete_permissions/);
  });

  it("v_my_blocks is registered in tables.yaml", () => {
    const tables = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/tables.yaml",
      ),
      "utf8",
    );
    expect(tables).toContain("public_v_my_blocks.yaml");
    expect(tables).toContain("public_player_blocks.yaml");
  });

  it("support_requests can only be created by verified_user and above, not plain user/guest", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_support_requests.yaml",
      ),
      "utf8",
    );
    const start = metadata.indexOf("insert_permissions:");
    const end = metadata.indexOf("select_permissions:", start);
    const insertSection = metadata.slice(start, end);
    expect(insertSection).toMatch(/role:\s*verified_user/);
    // The only insert_permissions entry -- not a second one still on "user".
    expect((insertSection.match(/^\s*- role:/gm) ?? []).length).toBe(1);
  });

  it("support_requests select/update permissions are unchanged (existing access to own/admin requests preserved)", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_support_requests.yaml",
      ),
      "utf8",
    );
    expect(metadata).toMatch(/select_permissions:[\s\S]*role:\s*user/);
    expect(metadata).toMatch(/select_permissions:[\s\S]*role:\s*administrator/);
    expect(metadata).toMatch(/update_permissions:[\s\S]*role:\s*administrator/);
  });

  it("support_request_messages (replies) permissions are untouched -- still role user for the request owner", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_support_request_messages.yaml",
      ),
      "utf8",
    );
    const insertSection = metadata.slice(metadata.indexOf("insert_permissions:"));
    expect(insertSection).toMatch(/role:\s*user/);
  });

  it("verification_applications insert permission deliberately stays on role user (unverified players must still be able to apply)", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_verification_applications.yaml",
      ),
      "utf8",
    );
    const insertSection = metadata.slice(metadata.indexOf("insert_permissions:"));
    expect(insertSection).toMatch(/role:\s*user/);
  });

  it("the inherited_roles chain makes verified_user cumulative up to administrator (the mechanism the support-request restriction relies on)", () => {
    const inherited = fs.readFileSync(
      path.resolve("hasura/metadata/inherited_roles.yaml"),
      "utf8",
    );
    // administrator -> tournament_organizer -> match_organizer -> moderator
    // -> streamer -> verified_user -> user -> guest
    expect(inherited).toMatch(/role_name: administrator[\s\S]*?tournament_organizer/);
    expect(inherited).toMatch(/role_name: streamer[\s\S]*?verified_user/);
    expect(inherited).toMatch(/role_name: verified_user[\s\S]*?- user/);
  });
});
