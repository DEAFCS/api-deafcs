import fs from "fs";
import path from "path";
import { load } from "js-yaml";
import { canStaffReadFinishedMatchChat } from "../src/chat/chat.service";

const metadata = (relativePath: string) =>
  load(
    fs.readFileSync(
      path.resolve("hasura/metadata/databases/default", relativePath),
      "utf8",
    ),
  ) as Record<string, any>;

const selectFor = (table: string, role: string) =>
  metadata(`tables/${table}.yaml`).select_permissions.find(
    (entry: any) => entry.role === role,
  );

describe("moderator post-match chat log access", () => {
  it.each(["Finished", "Forfeit", "Surrendered", "Tie", "Canceled"])(
    "lets staff read a %s match",
    (status) => {
      for (const role of [
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ] as const) {
        expect(canStaffReadFinishedMatchChat(status, role)).toBe(true);
      }
    },
  );

  it("never opens a live match, whatever the role", () => {
    for (const status of ["Live", "Scheduled", "PickingPlayers", "Veto"]) {
      expect(canStaffReadFinishedMatchChat(status, "administrator")).toBe(
        false,
      );
      expect(canStaffReadFinishedMatchChat(status, "moderator")).toBe(false);
    }
    expect(canStaffReadFinishedMatchChat(undefined, "moderator")).toBe(false);
  });

  it("keeps ordinary players out", () => {
    for (const role of ["user", "verified_user", "streamer"] as const) {
      expect(canStaffReadFinishedMatchChat("Finished", role)).toBe(false);
    }
  });
});

describe("moderator sanction visibility metadata", () => {
  it("gives moderators the full sanction history but not chat evidence", () => {
    const moderator = selectFor("public_player_sanctions", "moderator");
    expect(moderator.permission.filter).toEqual({});
    expect(moderator.permission.columns).toEqual(
      expect.arrayContaining([
        "player_steam_id",
        "type",
        "reason",
        "created_at",
        "remove_sanction_date",
        "deleted_at",
      ]),
    );
    expect(moderator.permission.computed_fields).toContain("is_active");
    expect(moderator.permission.columns).not.toContain("evidence_message_id");
  });

  it("keeps normal users on active bans only", () => {
    for (const role of ["guest", "user"]) {
      const permission = selectFor("public_player_sanctions", role).permission;
      expect(JSON.stringify(permission.filter)).toContain('"type":{"_eq":"ban"}');
      expect(JSON.stringify(permission.filter)).toContain("is_active");
    }
  });

  it("leaves administrator access unchanged", () => {
    const administrator = selectFor("public_player_sanctions", "administrator");
    expect(administrator.permission.filter).toEqual({});
    expect(administrator.permission.columns).toContain("evidence_message_id");
  });

  it("lets moderators read abandoned-match bans, but not delete them", () => {
    const abandoned = metadata("tables/public_abandoned_matches.yaml");
    const moderator = abandoned.select_permissions.find(
      (entry: any) => entry.role === "moderator",
    );
    expect(moderator.permission.filter).toEqual({});
    expect(
      (abandoned.delete_permissions ?? []).some(
        (entry: any) => entry.role === "moderator",
      ),
    ).toBe(false);
  });

  it("still only exposes chat deletion evidence to administrators", () => {
    const roles = metadata(
      "tables/public_chat_message_deletions.yaml",
    ).select_permissions.map((entry: any) => entry.role);
    expect(roles).toEqual(["administrator"]);
  });
});
