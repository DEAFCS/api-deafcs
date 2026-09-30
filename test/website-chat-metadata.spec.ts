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
    // guest/user only ever see the CURRENTLY ACTIVE "ban" type (see
    // player_sanction_is_active) -- website_chat_mute can never come back
    // from either, since it's a stricter allowlist than the old
    // "everything except mute/restriction" denylist this used to check.
    expect(metadata).toMatch(/role: guest[\s\S]*type:\s*\n\s*_eq: ban/);
    expect(metadata).toMatch(/role: user[\s\S]*type:\s*\n\s*_eq: ban/);
    expect(metadata.match(/_nin:\s*\n\s*- website_chat_mute/g)?.length).toBe(
      4,
    );
    expect(metadata).toMatch(
      /role: administrator[\s\S]*revoked_by_steam_id[\s\S]*evidence_message_id/,
    );
  });
});
