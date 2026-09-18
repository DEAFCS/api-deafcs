import fs from "fs";
import path from "path";

describe("website chat moderation metadata", () => {
  it("exposes deleted-message evidence only to administrators", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_chat_message_deletions.yaml",
      ),
      "utf8",
    );
    expect(metadata).toContain("role: administrator");
    expect(metadata).not.toMatch(/role: (guest|user|moderator|match_organizer)/);
  });

  it("keeps website mute evidence out of guest sanction queries and updates", () => {
    const metadata = fs.readFileSync(
      path.resolve(
        "hasura/metadata/databases/default/tables/public_player_sanctions.yaml",
      ),
      "utf8",
    );
    expect(metadata).toMatch(
      /role: guest[\s\S]*type:\s*\n\s*_neq: website_chat_mute/,
    );
    expect(metadata.match(/_neq: website_chat_mute/g)?.length).toBeGreaterThanOrEqual(5);
    expect(metadata).toMatch(
      /role: administrator[\s\S]*revoked_by_steam_id[\s\S]*evidence_message_id/,
    );
  });
});
