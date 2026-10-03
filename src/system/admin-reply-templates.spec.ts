import { readFileSync } from "fs";
import { join } from "path";

const hasura = join(__dirname, "../../hasura");
const read = (file: string) => readFileSync(join(hasura, file), "utf8");

describe("admin_reply_templates", () => {
  const metadata = read(
    "metadata/databases/default/tables/public_admin_reply_templates.yaml",
  );
  const migration = read(
    "migrations/default/1878000023000_create_table_admin_reply_templates/up.sql",
  );

  it("is tracked by Hasura", () => {
    expect(read("metadata/databases/default/tables/tables.yaml")).toContain(
      "public_admin_reply_templates.yaml",
    );
  });

  it("limits the table to five slots and bounded text", () => {
    expect(migration).toMatch(/"slot" BETWEEN 1 AND 5/);
    expect(migration).toMatch(/char_length\("body"\) <= 4000/);
    expect(migration).toMatch(/PRIMARY KEY \("owner_steam_id", "slot"\)/);
  });

  it("only staff roles have access, never plain users", () => {
    const roles = [...metadata.matchAll(/- role: (\w+)/g)].map((m) => m[1]);
    expect(new Set(roles)).toEqual(new Set(["administrator", "moderator"]));
  });

  it("scopes every select, update and delete to the caller's own rows", () => {
    const own = /owner_steam_id:\n\s+_eq: X-Hasura-User-Id/g;
    // 2 roles x (insert check + select + update filter + update check + delete)
    expect(metadata.match(own)?.length).toBe(10);
  });

  it("forces the owner on insert so it cannot be spoofed", () => {
    expect(metadata.match(/owner_steam_id: x-hasura-user-id/g)?.length).toBe(2);
    const insertPart = metadata.split("select_permissions")[0];
    expect(insertPart).not.toMatch(/^\s+- owner_steam_id$/m);
  });
});
