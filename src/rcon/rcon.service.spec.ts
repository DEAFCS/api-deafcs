import { RconService } from "./rcon.service";

// DEAFCS: RCON is for administrators only, on every server.
describe("RconService.canAccessServer", () => {
  const build = () => {
    const query = jest.fn();

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

  it("lets an administrator in", async () => {
    const { service, query } = build();

    await expect(
      service.canAccessServer("srv", user("administrator")),
    ).resolves.toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
  ])("never lets a %s in, and does not look the server up", async (role) => {
    const { service, query } = build();

    await expect(service.canAccessServer("srv", user(role))).resolves.toBe(
      false,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
