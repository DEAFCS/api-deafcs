import { readFileSync } from "fs";
import { join } from "path";
import { SystemController } from "./system.controller";
import { User } from "../auth/types/User";
import { e_player_roles_enum } from "generated";

const ME = "76561190000000001";
const OTHER = "76561190000000002";

const user = (role: e_player_roles_enum, steamId = ME): User => ({
  name: "Test",
  role,
  steam_id: steamId,
});

function callRequestNameChange(data: {
  user?: User;
  name: string;
  steam_id: string;
}) {
  const hasura = {
    query: jest
      .fn()
      .mockResolvedValueOnce({ notifications: [] })
      .mockResolvedValueOnce({ players_by_pk: { name: "Old" } }),
  };
  const notifications = { send: jest.fn().mockResolvedValue(undefined) };
  const promise = SystemController.prototype.requestNameChange.call(
    { hasura, notifications },
    data,
  );
  return { promise, hasura, notifications };
}

describe("SystemController.requestNameChange - self only", () => {
  it("lets a player request their own name change", async () => {
    const { promise, notifications } = callRequestNameChange({
      user: user("verified_user"),
      name: "NewName",
      steam_id: ME,
    });
    await expect(promise).resolves.toEqual({ success: true });
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it.each(["user", "verified_user", "moderator"] as e_player_roles_enum[])(
    "rejects %s requesting a name change for ANOTHER player",
    async (role) => {
      const { promise, hasura, notifications } = callRequestNameChange({
        user: user(role),
        name: "NewName",
        steam_id: OTHER,
      });
      await expect(promise).rejects.toThrow(
        /only request a name change for yourself/,
      );
      expect(hasura.query).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    },
  );

  it("rejects an unauthenticated call", async () => {
    const { promise } = callRequestNameChange({
      name: "NewName",
      steam_id: ME,
    });
    await expect(promise).rejects.toThrow();
  });
});

// Name and country for another player are edited directly through Hasura's
// update_players_by_pk. Pin the permission rows so a metadata change cannot
// silently hand moderators (or anyone below administrator) edit rights on
// other players' profile fields.
describe("Hasura players update permissions", () => {
  const yaml = readFileSync(
    join(
      __dirname,
      "../../hasura/metadata/databases/default/tables/public_players.yaml",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const updateBlock = yaml
    .split("update_permissions:")[1]
    .split("delete_permissions:")[0];
  const roleBlock = (role: string) =>
    updateBlock.split(`- role: ${role}\n`)[1]?.split("\n  - role:")[0];

  it("administrator may update name, country and avatar_url on any player", () => {
    const admin = roleBlock("administrator");
    expect(admin).toMatch(/- name\n/);
    expect(admin).toMatch(/- country\n/);
    expect(admin).toMatch(/- avatar_url\n/);
    expect(admin).toMatch(/filter: \{\}/);
  });

  it("user role (inherited by verified_user/moderator) is filtered to self and cannot set name", () => {
    const self = roleBlock("user");
    expect(self).toMatch(/steam_id:\n\s+_eq: X-Hasura-User-Id/);
    expect(self).not.toMatch(/- name\n/);
    expect(self).not.toMatch(/- avatar_url\n/);
  });

  it("moderator has no update permission row of its own", () => {
    expect(roleBlock("moderator")).toBeUndefined();
  });
});
