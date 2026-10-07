import fs from "fs";
import path from "path";
import { load } from "js-yaml";

// The support pages subscribe to support_requests and
// support_request_messages. A subscription is only as visible as the select
// permission behind it, so these pin the intended audience of both tables.
const table = (name: string) =>
  load(
    fs.readFileSync(
      path.resolve("hasura/metadata/databases/default/tables", `${name}.yaml`),
      "utf8",
    ),
  ) as Record<string, any>;

const requests = table("public_support_requests");
const messages = table("public_support_request_messages");
const roles = (entries: any[] = []) => entries.map((entry) => entry.role).sort();
const select = (meta: Record<string, any>, role: string) =>
  meta.select_permissions.find((entry: any) => entry.role === role);

describe("support request subscriptions stay private", () => {
  it("only the owner and staff can select requests and messages", () => {
    expect(roles(requests.select_permissions)).toEqual(["administrator", "moderator", "user"]);
    expect(roles(messages.select_permissions)).toEqual(["administrator", "moderator", "user"]);
  });

  it("scopes a normal user to their own requests, including private player reports", () => {
    expect(select(requests, "user").permission.filter).toEqual({
      player_steam_id: { _eq: "X-Hasura-User-Id" },
    });
  });

  it("scopes a normal user to the messages of their own requests", () => {
    expect(select(messages, "user").permission.filter).toEqual({
      request: { player_steam_id: { _eq: "X-Hasura-User-Id" } },
    });
  });

  it("gives staff the whole queue and nobody else more", () => {
    for (const meta of [requests, messages]) {
      expect(select(meta, "moderator").permission.filter).toEqual({});
      expect(select(meta, "administrator").permission.filter).toEqual({});
    }
  });

  it("keeps the report and organizer-application fields on the same owner/staff gate", () => {
    for (const role of ["user", "moderator", "administrator"]) {
      const columns = select(requests, role).permission.columns;
      expect(columns).toEqual(
        expect.arrayContaining(["reported_player_steam_id", "report_details", "organizer_motivation"]),
      );
    }
    // No other role (guest, verified_user, match_organizer, ...) has its own entry.
    expect(roles(requests.select_permissions)).not.toContain("guest");
  });

  it("does not switch the live (subscription) root fields off for either table", () => {
    expect(requests.configuration?.subscription_root_fields).toBeUndefined();
    expect(messages.configuration?.subscription_root_fields).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("subscription_root_fields");
  });

  it("limits status changes to staff, who are recorded as the handler", () => {
    expect(roles(requests.update_permissions)).toEqual(["administrator", "moderator"]);
    for (const entry of requests.update_permissions) {
      expect(entry.permission.columns).toEqual(["status"]);
      expect(entry.permission.set).toEqual({ handled_by_steam_id: "x-hasura-user-id" });
    }
  });

  it("keeps message inserts to the owner and staff", () => {
    expect(roles(messages.insert_permissions)).toEqual(["administrator", "moderator", "user"]);
  });
});
