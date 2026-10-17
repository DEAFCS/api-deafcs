import { RconService } from "./rcon.service";

// Who may open RCON on a server. Players never may; a Pracc server (a match
// server under the hood, hidden from the matches select for every role) is
// reachable by administrators only, which is what the website's staff-only
// practice server id assumes.
describe("RconService.canAccessServer", () => {
  const build = (
    options: {
      server?: { is_dedicated: boolean } | null;
      organizerOf?: boolean[];
    } = {},
  ) => {
    const query = jest.fn(async (request: any) => {
      if (request.servers_by_pk) {
        return {
          servers_by_pk:
            options.server === undefined
              ? { is_dedicated: false }
              : options.server,
        };
      }
      return {
        matches: (options.organizerOf ?? []).map((is_organizer) => ({
          is_organizer,
        })),
      };
    });

    const service = new RconService(
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    return { service, query };
  };

  const user = (role: string) =>
    ({ steam_id: "76561198000000001", role }) as never;

  it("always lets an administrator in", async () => {
    const { service, query } = build();

    await expect(
      service.canAccessServer("srv", user("administrator")),
    ).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["user", "verified_user", "streamer"])(
    "never lets a %s in, and does not even look the server up",
    async (role) => {
      const { service, query } = build({ server: { is_dedicated: true } });

      await expect(service.canAccessServer("srv", user(role))).resolves.toBe(
        false,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("lets a moderator onto a dedicated server", async () => {
    const { service } = build({ server: { is_dedicated: true } });

    await expect(
      service.canAccessServer("srv", user("moderator")),
    ).resolves.toBe(true);
  });

  it("keeps a moderator off a practice server, whose match they cannot see", async () => {
    // The matches select filters practice matches out, so the organizer
    // lookup comes back empty for every role but the administrator's bypass.
    const { service } = build({
      server: { is_dedicated: false },
      organizerOf: [],
    });

    await expect(
      service.canAccessServer("srv", user("moderator")),
    ).resolves.toBe(false);
  });

  it("lets a moderator organizing a live match onto its server", async () => {
    const { service } = build({
      server: { is_dedicated: false },
      organizerOf: [true],
    });

    await expect(
      service.canAccessServer("srv", user("moderator")),
    ).resolves.toBe(true);
  });

  it("refuses a server that does not exist", async () => {
    const { service } = build({ server: null });

    await expect(
      service.canAccessServer("srv", user("moderator")),
    ).resolves.toBe(false);
  });
});
