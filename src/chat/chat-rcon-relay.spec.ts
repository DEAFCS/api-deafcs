import { ChatGateway } from "./chat.gateway";
import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// Match chat is relayed into the game server as one rcon command with the
// message inlined in quotes (upstream 495616ca #410, 452c20c8 #460, dd17775e
// #435). Whatever a player or their Steam name contains must stay inside that
// one argument of that one command: a newline or a quote would turn the rest
// into console input on the server.
describe("match chat relayed to the game server", () => {
  const rcon = { connect: jest.fn(), send: jest.fn() };
  let match: {
    status: string;
    server: { id: string; plugin_runtime: string } | null;
  };
  let service: ChatService;

  // One command, one quoted argument, nothing the console or the plugin's
  // tokenizer would read as the end of either.
  const ONE_ARGUMENT = /^(sw|css)_web_chat "[^"\r\n\x00-\x1f\u200b]*"$/;

  const relayed = async (message: string) => {
    rcon.send.mockClear();
    await service.sendChatToServer("match-1", message);
    expect(rcon.send).toHaveBeenCalledTimes(1);
    return rcon.send.mock.calls[0][0] as string;
  };

  beforeEach(() => {
    match = {
      status: "Live",
      server: { id: "server-1", plugin_runtime: "swiftly" },
    };
    rcon.send.mockReset().mockResolvedValue("");
    rcon.connect.mockReset().mockResolvedValue(rcon);

    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      { connect: rcon.connect } as any,
      { query: jest.fn(async () => ({ matches_by_pk: match })) } as any,
      {} as any,
      { getConnection: () => ({}) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("sends the message as one quoted argument", async () => {
    expect(await relayed("Player: nice shot")).toBe(
      'sw_web_chat "Player: nice shot"',
    );
  });

  it("uses the CounterStrikeSharp command on those servers", async () => {
    match.server!.plugin_runtime = "counterstrikesharp";
    expect(await relayed("Player: gg")).toBe('css_web_chat "Player: gg"');
  });

  it("puts every line of a multi line message on one line", async () => {
    expect(await relayed("Player: top\nbottom")).toBe(
      'sw_web_chat "Player: top bottom"',
    );
    expect(await relayed("Player: top\r\nbottom")).toBe(
      'sw_web_chat "Player: top bottom"',
    );
    expect(await relayed("Player: top\rbottom")).toBe(
      'sw_web_chat "Player: top bottom"',
    );
  });

  it("keeps a command after a line break inside the chat text", async () => {
    const sent = await relayed('Player: gg\nrcon_password "owned"\nquit');

    expect(sent).toBe('sw_web_chat "Player: gg rcon_password owned quit"');
    expect(sent).toMatch(ONE_ARGUMENT);
  });

  it("strips quotes so the message cannot close the argument", async () => {
    expect(await relayed('x" ; quit ; say "')).toBe(
      'sw_web_chat "x ; quit ; say"',
    );
  });

  it("drops control characters and U+200B", async () => {
    expect(await relayed("Player: a\x00b\tc\x1bd\u200be")).toBe(
      'sw_web_chat "Player: abcde"',
    );
  });

  it.each([
    "\n",
    "\r\n\r\n",
    "gg\n\nexec autoexec",
    'a"\nb"',
    "\u200b\u200bsay hi\u200b",
    "x\u0000\nchangelevel de_dust2",
    'Player: ";sv_cheats 1;"',
    'Player: \\"\nquit',
    " quit ",
  ])("keeps %j inside one argument", async (message) => {
    expect(await relayed(message)).toMatch(ONE_ARGUMENT);
  });

  it("keeps Unicode, emoji and punctuation as typed", async () => {
    const text =
      "Player: Größe naïve 你好 مرحبا 🇩🇪 👍🏽 'quoted' ; 100% & <b>#1</b>";

    expect(await relayed(text)).toBe(`sw_web_chat "${text}"`);
  });

  it("cuts a long message to the in-game length between graphemes", async () => {
    const sent = await relayed(`Player: ${"🇩🇪".repeat(400)}`);
    const body = sent.slice('sw_web_chat "'.length, -1);

    expect(Array.from(body).length).toBeLessThanOrEqual(
      ChatService.RCON_MESSAGE_MAX_LENGTH,
    );
    expect(body.endsWith("…")).toBe(true);
    // No flag is split into its two regional indicators.
    expect(body.replace("Player: ", "").replace("…", "")).toMatch(/^(🇩🇪)+$/u);
    expect(sent).toMatch(ONE_ARGUMENT);
  });

  it("sends nothing when the match is not live or has no server", async () => {
    match.status = "Finished";
    await service.sendChatToServer("match-1", "gg\nquit");

    match = { status: "Live", server: null };
    await service.sendChatToServer("match-1", "gg\nquit");

    expect(rcon.send).not.toHaveBeenCalled();
  });

  // The websocket is what a player can reach directly: a crafted lobby message
  // goes through the gateway exactly as the website's own would.
  describe("a chat message sent straight over the websocket", () => {
    const send = async (
      user: { steam_id: string; name: string; role: string },
      message: string,
    ) => {
      rcon.send.mockClear();
      const chat = {
        sendMessageToChat: jest.fn().mockResolvedValue({ accepted: true }),
        sendChatToServer: service.sendChatToServer.bind(service),
      };

      await new ChatGateway(chat as any).lobby(
        { id: "match-1", type: ChatLobbyType.Match, message } as any,
        { user, send: jest.fn() } as any,
      );

      expect(rcon.send).toHaveBeenCalledTimes(1);
      return rcon.send.mock.calls[0][0] as string;
    };

    const player = {
      steam_id: "76561198000000001",
      name: "vexa",
      role: "user",
    };

    it("relays a player's line break as a space", async () => {
      expect(await send(player, 'gg\nrcon_password "x"\nquit')).toBe(
        "sw_web_chat \"vexa: gg rcon_password 'x' quit\"",
      );
    });

    it("keeps a Steam name with a line break or quote inside the argument", async () => {
      const sent = await send({ ...player, name: 'evil"\nquit\n"' }, "hello");

      expect(sent).toMatch(ONE_ARGUMENT);
      expect(sent).toBe("sw_web_chat \"evil' quit ': hello\"");
    });

    it("keeps the organizer prefix the DEAFCS plugin reads", async () => {
      expect(
        await send({ ...player, role: "match_organizer" }, "pause\nquit"),
      ).toBe('sw_web_chat "[organizer] vexa: pause quit"');
    });
  });
});
