import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// The match scoreboard's status dot is green while the match lobby lists the
// player as inGame (set from the game server's player-connected event). A
// player who closed the match page while still playing used to be dropped
// from the lobby, inGame and all, and showed red (or orange once the site
// reconnected).
describe("match lobby: leaving the website while in the game server", () => {
  let service: ChatService;
  let stored: Record<string, any> | null;
  let remainingSessions: number;
  let to: jest.SpyInstance;
  let removeUserData: jest.SpyInstance;

  const client = { id: "tab-1", user: { steam_id: "76561198000000001" } };

  beforeEach(() => {
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      { getConnection: () => ({}) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    stored = null;
    remainingSessions = 0;
    jest
      .spyOn(service as any, "getUserData")
      .mockImplementation(async () => stored);
    jest
      .spyOn(service as any, "removeSession")
      .mockImplementation(async () => [1, remainingSessions]);
    removeUserData = jest
      .spyOn(service as any, "removeUserData")
      .mockImplementation(async () => undefined);
    to = jest
      .spyOn(service as any, "to")
      .mockImplementation(async () => undefined);
  });

  it("keeps a player who is in the game server listed as in game", async () => {
    stored = { user: { steam_id: client.user.steam_id }, inGame: true };

    await service.removeFromLobby(
      ChatLobbyType.Match,
      "match-1",
      client as any,
    );

    expect(removeUserData).not.toHaveBeenCalled();
    expect(to).toHaveBeenCalledWith(ChatLobbyType.Match, "match-1", "joined", {
      user: { steam_id: client.user.steam_id, inGame: true },
    });
  });

  it("still removes a player who isn't in the game server", async () => {
    stored = { user: { steam_id: client.user.steam_id } };

    await service.removeFromLobby(
      ChatLobbyType.Match,
      "match-1",
      client as any,
    );

    expect(removeUserData).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      "match-1",
      client.user.steam_id,
    );
    expect(to).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      "match-1",
      "left",
      expect.anything(),
    );
  });

  it("leaves other open tabs alone", async () => {
    stored = { user: { steam_id: client.user.steam_id }, inGame: true };
    remainingSessions = 1;

    await service.removeFromLobby(
      ChatLobbyType.Match,
      "match-1",
      client as any,
    );

    expect(removeUserData).not.toHaveBeenCalled();
    expect(to).toHaveBeenCalledWith(ChatLobbyType.Match, "match-1", "joined", {
      user: { steam_id: client.user.steam_id, inGame: true },
    });
  });
});
