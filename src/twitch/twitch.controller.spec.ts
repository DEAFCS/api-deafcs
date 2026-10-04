import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { TwitchController } from "./twitch.controller";

const M1 = "11111111-1111-4111-8111-111111111111";

describe("TwitchController", () => {
  let streams: {
    getPlayerTwitch: jest.Mock;
    getOwnChannel: jest.Mock;
    setOwnChannel: jest.Mock;
    getMatchAutoStreams: jest.Mock;
  };
  let controller: TwitchController;
  const req = (user?: any) => ({ user }) as any;

  beforeEach(() => {
    streams = {
      getPlayerTwitch: jest.fn(),
      getOwnChannel: jest.fn(),
      setOwnChannel: jest.fn(),
      getMatchAutoStreams: jest.fn(),
    };
    controller = new TwitchController(streams as any);
  });

  it("player lookup is public and has a safe default", async () => {
    streams.getPlayerTwitch.mockResolvedValue(null);
    expect(await controller.getPlayer("123")).toEqual({
      channel: null,
      live: false,
      gameName: null,
      title: null,
      checkedAt: null,
    });
  });

  it("me routes require a session and always use the session's steam id", async () => {
    await expect(controller.getMine(req())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.setMine(req(), { channel: "tricon" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(streams.setOwnChannel).not.toHaveBeenCalled();

    streams.setOwnChannel.mockResolvedValue({ ok: true, channel: "tricon" });
    // A steam id in the body is ignored: only the session decides whose row.
    expect(
      await controller.setMine(req({ steam_id: "42" }), { channel: "TricoN", steam_id: "999" } as any),
    ).toEqual({ channel: "tricon" });
    expect(streams.setOwnChannel).toHaveBeenCalledWith("42", "TricoN");
  });

  it("invalid channel => 400 with the reason", async () => {
    streams.setOwnChannel.mockResolvedValue({ ok: false, error: "unsupported_url" });
    await expect(
      controller.setMine(req({ steam_id: "42" }), { channel: "https://clips.twitch.tv/x" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("match streams pass the viewer for the anti-cheat check (null for guests)", async () => {
    streams.getMatchAutoStreams.mockResolvedValue({ [M1]: [] });
    await controller.getMatchStreams(req({ steam_id: "42" }), `${M1},junk`);
    expect(streams.getMatchAutoStreams).toHaveBeenLastCalledWith([M1], "42");
    await controller.getMatchStreams(req(), M1);
    expect(streams.getMatchAutoStreams).toHaveBeenLastCalledWith([M1], null);
  });
});
