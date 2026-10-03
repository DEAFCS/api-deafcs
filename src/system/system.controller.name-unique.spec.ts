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

// postgres.query answers in call order. "taken" rows model the case-
// insensitive name lookup finding another registered player.
function harness(rows: Array<Array<Record<string, unknown>>>) {
  const query = jest.fn();
  for (const result of rows) query.mockResolvedValueOnce(result);
  query.mockResolvedValue([]);
  const mutation = jest.fn().mockResolvedValue({});
  const hasura = {
    mutation,
    query: jest
      .fn()
      .mockResolvedValueOnce({ notifications: [] })
      .mockResolvedValueOnce({ players_by_pk: { name: "Old" } }),
  };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    notifyPlayers: jest.fn().mockResolvedValue(undefined),
  };
  const self = { postgres: { query }, hasura, notifications };
  return { self, query, mutation, hasura, notifications };
}

const taken = [{ steam_id: OTHER }];

describe("registerName - unique registered names", () => {
  const register = (self: unknown, name = "NewName") =>
    SystemController.prototype.registerName.call(self, {
      user: user("user"),
      name,
    });

  it("registers a free name", async () => {
    const { self, mutation } = harness([[{ name_registered: false }], []]);
    await expect(register(self)).resolves.toEqual({ success: true });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("refuses a name another registered player already has", async () => {
    const { self, mutation } = harness([[{ name_registered: false }], taken]);
    await expect(register(self)).rejects.toThrow(
      SystemController.NAME_TAKEN_MESSAGE,
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("looks the name up case-insensitively, excluding the caller", async () => {
    const { self, query } = harness([[{ name_registered: false }], []]);
    await register(self, "Neo");
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/name_registered IS TRUE/);
    expect(sql).toMatch(/lower\(name\) = lower\(\$1\)/);
    expect(params).toEqual(["Neo", ME]);
  });

  it("refuses a player who already registered (no renaming around approval)", async () => {
    const { self, mutation } = harness([[{ name_registered: true }]]);
    await expect(register(self)).rejects.toThrow(/already registered/);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("turns the database unique-index violation into the same message", async () => {
    const { self, mutation } = harness([[{ name_registered: false }], []]);
    // hasura.mutation rethrows the GraphQL message as a plain string.
    mutation.mockRejectedValue(
      'Uniqueness violation. duplicate key value violates unique constraint "players_registered_name_unique"',
    );
    await expect(register(self)).rejects.toThrow(
      SystemController.NAME_TAKEN_MESSAGE,
    );
  });

  it("still rejects names outside the format rule", async () => {
    const { self } = harness([]);
    await expect(register(self, "bad name")).rejects.toThrow(
      /letters, numbers/,
    );
  });
});

describe("requestNameChange / approveNameChange - unique registered names", () => {
  it("rejects a request for a taken name before notifying admins", async () => {
    const { self, notifications } = harness([taken]);
    await expect(
      SystemController.prototype.requestNameChange.call(self, {
        user: user("verified_user"),
        name: "Taken",
        steam_id: ME,
      }),
    ).rejects.toThrow(SystemController.NAME_TAKEN_MESSAGE);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("re-checks at approval: a name taken meanwhile is not applied", async () => {
    const { self, mutation, notifications } = harness([taken]);
    await expect(
      SystemController.prototype.approveNameChange.call(self, {
        name: "Taken",
        steam_id: ME,
      }),
    ).rejects.toThrow(SystemController.NAME_TAKEN_MESSAGE);
    expect(mutation).not.toHaveBeenCalled();
    expect(notifications.notifyPlayers).not.toHaveBeenCalled();
  });

  it("approves a free name", async () => {
    const { self, mutation } = harness([[]]);
    await expect(
      SystemController.prototype.approveNameChange.call(self, {
        name: "Free",
        steam_id: ME,
      }),
    ).resolves.toEqual({ success: true });
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});

describe("isPlayerNameAvailable", () => {
  const check = (self: unknown, data: Record<string, unknown>) =>
    SystemController.prototype.isPlayerNameAvailable.call(self, data);

  it("reports a free and a taken name", async () => {
    const free = harness([[]]);
    await expect(
      check(free.self, { user: user("user"), name: "Free" }),
    ).resolves.toEqual({ available: true });

    const busy = harness([taken]);
    await expect(
      check(busy.self, { user: user("user"), name: "Taken" }),
    ).resolves.toEqual({ available: false });
  });

  it("excludes the caller's own steam id so keeping your name is allowed", async () => {
    const { self, query } = harness([[]]);
    await check(self, { user: user("user"), name: "Mine" });
    expect(query.mock.calls[0][1]).toEqual(["Mine", ME]);
  });

  it("lets only administrators check on behalf of another player", async () => {
    const regular = harness([[]]);
    await expect(
      check(regular.self, {
        user: user("verified_user"),
        name: "X",
        steam_id: OTHER,
      }),
    ).rejects.toThrow(/only check a name for yourself/);

    const admin = harness([[]]);
    await check(admin.self, {
      user: user("administrator"),
      name: "X",
      steam_id: OTHER,
    });
    expect(admin.query.mock.calls[0][1]).toEqual(["X", OTHER]);
  });

  it("treats an empty name as nothing to check and rejects anonymous calls", async () => {
    const { self, query } = harness([]);
    await expect(
      check(self, { user: user("user"), name: "  " }),
    ).resolves.toEqual({ available: true });
    expect(query).not.toHaveBeenCalled();
    await expect(check(self, { name: "X" })).rejects.toThrow();
  });
});

describe("registered-name uniqueness is enforced in the database too", () => {
  const migration = readFileSync(
    join(
      __dirname,
      "../../hasura/migrations/default/1878000021000_players_registered_name_unique/up.sql",
    ),
    "utf8",
  );

  it("adds a case-insensitive unique index limited to registered names", () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS players_registered_name_unique/);
    expect(migration).toMatch(/\(lower\(name\)\)/);
    expect(migration).toMatch(/WHERE name_registered IS TRUE/);
  });
});
